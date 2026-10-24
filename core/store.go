package main

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

type Store struct {
	pool *pgxpool.Pool
}

type User struct {
	ID          int64    `json:"id"`
	Username    string   `json:"username"`
	DisplayName string   `json:"displayName"`
	Roles       []string `json:"roles"`
	// Disabled 的账号不能登录，已有的会话也立即失效。
	Disabled bool `json:"disabled"`
}

func (u *User) IsAdmin() bool { return hasAnyRole(u.Roles, []string{"admin"}) }

const schema = `
CREATE TABLE IF NOT EXISTS users (
	id            BIGSERIAL PRIMARY KEY,
	username      TEXT NOT NULL UNIQUE,
	display_name  TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	roles         TEXT[] NOT NULL DEFAULT '{user}',
	created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
	token_hash BYTEA PRIMARY KEY,
	user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	expires_at TIMESTAMPTZ NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false;
-- 按人授权菜单：只记录和模块清单里默认值不同的部分，没有记录就按默认值。
CREATE TABLE IF NOT EXISTS menu_grants (
	user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	module_id TEXT NOT NULL,
	menu_id   TEXT NOT NULL,
	allowed   BOOLEAN NOT NULL,
	PRIMARY KEY (user_id, module_id, menu_id)
);
`

func (s *Store) Migrate(ctx context.Context) error {
	// 数据库可能还在启动，最多等 30 秒。
	var err error
	for i := 0; i < 30; i++ {
		if err = s.pool.Ping(ctx); err == nil {
			break
		}
		time.Sleep(time.Second)
	}
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, schema)
	return err
}

// EnsureAdmin 只在没有任何用户时创建管理员账号。
func (s *Store) EnsureAdmin(ctx context.Context, username, password string) error {
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	if len(password) < 8 {
		return errors.New("首次启动需要在 .env 中设置至少 8 位的 ADMIN_PASSWORD")
	}
	_, err := s.CreateUser(ctx, username, username, password, true)
	return err
}

// ---- 用户管理 ----

var errUsernameTaken = errors.New("用户名已被使用")

func rolesFor(admin bool) []string {
	if admin {
		return []string{"admin", "user"}
	}
	return []string{"user"}
}

func (s *Store) CreateUser(ctx context.Context, username, displayName, password string, admin bool) (*User, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	u := &User{Username: username, DisplayName: displayName, Roles: rolesFor(admin)}
	err = s.pool.QueryRow(ctx,
		`INSERT INTO users (username, display_name, password_hash, roles) VALUES ($1, $2, $3, $4)
		 ON CONFLICT (username) DO NOTHING RETURNING id`,
		username, displayName, string(hash), u.Roles).Scan(&u.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errUsernameTaken
	}
	return u, err
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, username, display_name, roles, disabled FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (User, error) {
		var u User
		err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Roles, &u.Disabled)
		return u, err
	})
}

func (s *Store) UserByID(ctx context.Context, id int64) (*User, error) {
	var u User
	err := s.pool.QueryRow(ctx, `SELECT id, username, display_name, roles, disabled FROM users WHERE id = $1`, id).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.Roles, &u.Disabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &u, err
}

// UpdateUser 修改显示名、是否管理员、是否停用。停用时删除这个人的全部会话，让他立即退出。
func (s *Store) UpdateUser(ctx context.Context, id int64, displayName string, admin, disabled bool) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET display_name = $2, roles = $3, disabled = $4 WHERE id = $1`,
		id, displayName, rolesFor(admin), disabled)
	if err == nil && disabled {
		_, err = s.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, id)
	}
	return err
}

// SetPassword 重置密码，并让这个人在所有设备上重新登录。
func (s *Store) SetPassword(ctx context.Context, id int64, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET password_hash = $2 WHERE id = $1`, id, string(hash)); err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, id)
	return err
}

// ---- 菜单授权 ----

// grants 是一个人对菜单的单独设置：模块 id → 菜单 id → 是否允许。
type grants map[string]map[string]bool

func (s *Store) Grants(ctx context.Context, userID int64) (grants, error) {
	rows, err := s.pool.Query(ctx, `SELECT module_id, menu_id, allowed FROM menu_grants WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	g := grants{}
	for rows.Next() {
		var module, menu string
		var allowed bool
		if err := rows.Scan(&module, &menu, &allowed); err != nil {
			return nil, err
		}
		if g[module] == nil {
			g[module] = map[string]bool{}
		}
		g[module][menu] = allowed
	}
	return g, rows.Err()
}

// SetGrant 单独允许或禁止一个菜单；allowed 为 nil 表示恢复默认值。
func (s *Store) SetGrant(ctx context.Context, userID int64, module, menu string, allowed *bool) error {
	if allowed == nil {
		_, err := s.pool.Exec(ctx,
			`DELETE FROM menu_grants WHERE user_id = $1 AND module_id = $2 AND menu_id = $3`, userID, module, menu)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO menu_grants (user_id, module_id, menu_id, allowed) VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id, module_id, menu_id) DO UPDATE SET allowed = EXCLUDED.allowed`,
		userID, module, menu, *allowed)
	return err
}

// CheckPassword 校验用户名和密码，失败时返回 nil。
func (s *Store) CheckPassword(ctx context.Context, username, password string) (*User, error) {
	var u User
	var hash string
	err := s.pool.QueryRow(ctx,
		`SELECT id, username, display_name, roles, password_hash FROM users WHERE username = $1 AND NOT disabled`, username).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.Roles, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		// 用户不存在时也做一次比较，避免通过响应时间判断用户名是否存在。
		bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return nil, nil
	}
	return &u, nil
}

var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("dummy-password"), bcrypt.DefaultCost)

func (s *Store) CreateSession(ctx context.Context, tokenHash []byte, userID int64, expires time.Time) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`, tokenHash, userID, expires)
	return err
}

func (s *Store) DeleteSession(ctx context.Context, tokenHash []byte) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, tokenHash)
	return err
}

// UserBySession 返回会话对应的用户，会话不存在或已过期时返回 nil。会话在用时按 renewedExpiry 续期。
func (s *Store) UserBySession(ctx context.Context, tokenHash []byte) (*User, error) {
	var u User
	var created, expires time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT u.id, u.username, u.display_name, u.roles, s.created_at, s.expires_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`, tokenHash).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.Roles, &created, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if next, ok := renewedExpiry(time.Now(), created, expires); ok {
		// 续期失败不影响这次请求，下次校验会再试。
		if _, err := s.pool.Exec(ctx, `UPDATE sessions SET expires_at = $2 WHERE token_hash = $1`, tokenHash, next); err != nil {
			slog.Warn("会话续期失败", "err", err)
		}
	}
	return &u, nil
}

func (s *Store) DeleteExpiredSessions(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE expires_at <= now()`)
	return err
}
