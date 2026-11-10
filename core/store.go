package main

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	// PersonID 是这个账号属于哪个人员，没有关联时为 nil。一个人员可以有多个账号。
	PersonID *int64 `json:"personId"`
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
-- 按人授权功能权限：和 menu_grants 一样只记录和默认值不同的部分。module_id 为 platform 时是平台自己的权限。
CREATE TABLE IF NOT EXISTS perm_grants (
	user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	module_id TEXT NOT NULL,
	perm_id   TEXT NOT NULL,
	allowed   BOOLEAN NOT NULL,
	PRIMARY KEY (user_id, module_id, perm_id)
);
-- 按人授权整个应用：关掉后这个应用对他隐藏，菜单和功能权限都不生效。module_id 为 platform 时是门户本身。
CREATE TABLE IF NOT EXISTS app_grants (
	user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	module_id TEXT NOT NULL,
	allowed   BOOLEAN NOT NULL,
	PRIMARY KEY (user_id, module_id)
);
-- 人员：家庭成员等，其他模块只保存人员 id。账号通过 users.person_id 关联到人员，删除人员时账号保留、只解除关联。
CREATE TABLE IF NOT EXISTS persons (
	id         BIGSERIAL PRIMARY KEY,
	name       TEXT NOT NULL,
	note       TEXT NOT NULL DEFAULT '',
	photo      TEXT NOT NULL DEFAULT '',
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS person_id BIGINT REFERENCES persons(id) ON DELETE SET NULL;
-- 成员备注：每个账号给成员写的备注只有自己看得到，和管理员维护的 persons.note 无关。
CREATE TABLE IF NOT EXISTS person_remarks (
	user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	person_id BIGINT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
	remark    TEXT NOT NULL,
	PRIMARY KEY (user_id, person_id)
);
-- 平台级的设置，例如默认主题 default_skin。
CREATE TABLE IF NOT EXISTS settings (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
-- 活跃度统计（见 stats.go），默认关闭。activity 是每人每个应用每分钟一行，保留 90 天；
-- activity_daily 是按天（按 STATS_TIMEZONE 算日期）的汇总，长期保留；login_events 是登录成功和失败，保留 90 天，
-- 用户名不存在的登录失败 user_id 为空，不记输入的用户名。
CREATE TABLE IF NOT EXISTS activity (
	user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	app     TEXT NOT NULL,
	minute  TIMESTAMPTZ NOT NULL,
	device  TEXT NOT NULL,
	PRIMARY KEY (user_id, app, minute)
);
CREATE INDEX IF NOT EXISTS activity_minute_idx ON activity (minute);
CREATE TABLE IF NOT EXISTS activity_daily (
	day     DATE NOT NULL,
	user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	app     TEXT NOT NULL,
	minutes INT NOT NULL,
	opens   INT NOT NULL,
	PRIMARY KEY (day, user_id, app)
);
CREATE TABLE IF NOT EXISTS login_events (
	at      TIMESTAMPTZ NOT NULL DEFAULT now(),
	user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
	ok      BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS login_events_at_idx ON login_events (at);
-- 关联了人员的账号，显示名称就是人员姓名。改姓名、关联账号时会一起改；这里把以前不一致的数据对齐一次。
UPDATE users u SET display_name = p.name FROM persons p WHERE p.id = u.person_id AND u.display_name <> p.name;
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

// CheckTimezone 确认 Postgres 认得这个时区名，免得统计在每次记录时才报错。
func (s *Store) CheckTimezone(ctx context.Context, tz string) error {
	_, err := s.pool.Exec(ctx, `SELECT now() AT TIME ZONE $1`, tz)
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
	_, err := s.CreateUser(ctx, username, username, password, true, nil)
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

// CreateUser 新建账号；personID 不为 nil 时同时关联到这个人员，显示名称用人员姓名，人员不存在时返回 errPersonNotFound。
func (s *Store) CreateUser(ctx context.Context, username, displayName, password string, admin bool, personID *int64) (*User, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	u := &User{Username: username, DisplayName: displayName, Roles: rolesFor(admin), PersonID: personID}
	err = s.pool.QueryRow(ctx,
		`INSERT INTO users (username, display_name, password_hash, roles, person_id)
		 VALUES ($1, COALESCE((SELECT name FROM persons WHERE id = $5), $2), $3, $4, $5)
		 ON CONFLICT (username) DO NOTHING RETURNING id, display_name`,
		username, displayName, string(hash), u.Roles, personID).Scan(&u.ID, &u.DisplayName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errUsernameTaken
	}
	if isForeignKeyViolation(err) {
		return nil, errPersonNotFound
	}
	return u, err
}

// SetUserPerson 把账号关联到人员，显示名称改成人员姓名；personID 为 nil 时解除关联，显示名称保持不变。
func (s *Store) SetUserPerson(ctx context.Context, id int64, personID *int64) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET person_id = $2, display_name = COALESCE((SELECT name FROM persons WHERE id = $2), display_name) WHERE id = $1`,
		id, personID)
	if isForeignKeyViolation(err) {
		return errPersonNotFound
	}
	return err
}

func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, username, display_name, roles, disabled, person_id FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (User, error) {
		var u User
		err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.Roles, &u.Disabled, &u.PersonID)
		return u, err
	})
}

func (s *Store) UserByID(ctx context.Context, id int64) (*User, error) {
	var u User
	err := s.pool.QueryRow(ctx, `SELECT id, username, display_name, roles, disabled, person_id FROM users WHERE id = $1`, id).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.Roles, &u.Disabled, &u.PersonID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &u, err
}

// UpdateUser 修改显示名、是否管理员、是否停用；关联了人员的账号显示名称跟着人员姓名，传入的 displayName 不生效。
// 停用时删除这个人的全部会话，让他立即退出。
func (s *Store) UpdateUser(ctx context.Context, id int64, displayName string, admin, disabled bool) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET display_name = COALESCE((SELECT name FROM persons WHERE id = users.person_id), $2), roles = $3, disabled = $4
		 WHERE id = $1`,
		id, displayName, rolesFor(admin), disabled)
	if err == nil && disabled {
		_, err = s.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1`, id)
	}
	return err
}

// SetPassword 重置密码，并让这个人在所有设备上重新登录。keepSession 不为空时保留这个会话（自己改密码时不用重新登录）。
func (s *Store) SetPassword(ctx context.Context, id int64, password string, keepSession []byte) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	if _, err := s.pool.Exec(ctx, `UPDATE users SET password_hash = $2 WHERE id = $1`, id, string(hash)); err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `DELETE FROM sessions WHERE user_id = $1 AND token_hash IS DISTINCT FROM $2`, id, keepSession)
	return err
}

// ---- 人员 ----

// Person 是一个人员。照片是压缩后的 JPEG（data URL），没有时为空。
type Person struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Note      string    `json:"note"`
	Photo     string    `json:"photo"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

var errPersonNotFound = errors.New("人员不存在")

const personColumns = `id, name, note, photo, created_at, updated_at`

func scanPerson(row pgx.Row) (*Person, error) {
	var p Person
	err := row.Scan(&p.ID, &p.Name, &p.Note, &p.Photo, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errPersonNotFound
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Store) ListPersons(ctx context.Context) ([]Person, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+personColumns+` FROM persons ORDER BY id`)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Person, error) {
		p, err := scanPerson(row)
		if err != nil {
			return Person{}, err
		}
		return *p, nil
	})
}

func (s *Store) PersonByID(ctx context.Context, id int64) (*Person, error) {
	return scanPerson(s.pool.QueryRow(ctx, `SELECT `+personColumns+` FROM persons WHERE id = $1`, id))
}

// PersonByUser 返回账号关联的人员，账号不存在或没有关联时返回 errPersonNotFound。
func (s *Store) PersonByUser(ctx context.Context, userID int64) (*Person, error) {
	return scanPerson(s.pool.QueryRow(ctx,
		`SELECT p.id, p.name, p.note, p.photo, p.created_at, p.updated_at
		 FROM users u JOIN persons p ON p.id = u.person_id WHERE u.id = $1`, userID))
}

func (s *Store) CreatePerson(ctx context.Context, name, note, photo string) (*Person, error) {
	return scanPerson(s.pool.QueryRow(ctx,
		`INSERT INTO persons (name, note, photo) VALUES ($1, $2, $3) RETURNING `+personColumns, name, note, photo))
}

// UpdatePerson 和 UpdatePersonName 改姓名时，关联的账号显示名称一起改。
func (s *Store) UpdatePerson(ctx context.Context, id int64, name, note, photo string) (*Person, error) {
	return scanPerson(s.pool.QueryRow(ctx, syncAccountNames(
		`UPDATE persons SET name = $2, note = $3, photo = $4, updated_at = now() WHERE id = $1 RETURNING `+personColumns),
		id, name, note, photo))
}

func (s *Store) UpdatePersonName(ctx context.Context, id int64, name string) (*Person, error) {
	return scanPerson(s.pool.QueryRow(ctx, syncAccountNames(
		`UPDATE persons SET name = $2, updated_at = now() WHERE id = $1 RETURNING `+personColumns), id, name))
}

// syncAccountNames 包住一条以 $1 为人员 id、$2 为新姓名的 UPDATE persons 语句，在同一条语句里把关联账号的显示名称改成新姓名。
// 人员不存在时两边都不改，照样返回 0 行。
func syncAccountNames(update string) string {
	return `WITH p AS (` + update + `),
		u AS (UPDATE users SET display_name = $2 WHERE person_id = (SELECT id FROM p))
		SELECT * FROM p`
}

func (s *Store) UpdatePersonPhoto(ctx context.Context, id int64, photo string) (*Person, error) {
	return scanPerson(s.pool.QueryRow(ctx,
		`UPDATE persons SET photo = $2, updated_at = now() WHERE id = $1 RETURNING `+personColumns, id, photo))
}

// DeletePerson 删除人员；他的账号保留，只是不再关联人员（外键 ON DELETE SET NULL）。
func (s *Store) DeletePerson(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM persons WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errPersonNotFound
	}
	return nil
}

// Member 是“成员”权限看到的成员：只有姓名、照片和自己写的备注，没有管理员的备注和账号。Self 表示是不是自己。
type Member struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Photo  string `json:"photo"`
	Remark string `json:"remark"`
	Self   bool   `json:"self"`
}

// ListMembers 返回全部成员，带上 userID 这个账号给他们写的备注。
func (s *Store) ListMembers(ctx context.Context, userID int64) ([]Member, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id, p.name, p.photo, COALESCE(r.remark, ''),
		       p.id IS NOT DISTINCT FROM (SELECT person_id FROM users WHERE id = $1)
		FROM persons p LEFT JOIN person_remarks r ON r.person_id = p.id AND r.user_id = $1
		ORDER BY p.id`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Member, error) {
		var m Member
		err := row.Scan(&m.ID, &m.Name, &m.Photo, &m.Remark, &m.Self)
		return m, err
	})
}

// Remarks 返回 userID 这个账号写过的全部备注：成员 id → 备注。
func (s *Store) Remarks(ctx context.Context, userID int64) (map[int64]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT person_id, remark FROM person_remarks WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var remark string
		if err := rows.Scan(&id, &remark); err != nil {
			return nil, err
		}
		out[id] = remark
	}
	return out, rows.Err()
}

// SetRemark 保存 userID 给成员写的备注；remark 为空时删除。成员不存在时返回 errPersonNotFound。
func (s *Store) SetRemark(ctx context.Context, userID, personID int64, remark string) error {
	if remark == "" {
		_, err := s.pool.Exec(ctx, `DELETE FROM person_remarks WHERE user_id = $1 AND person_id = $2`, userID, personID)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO person_remarks (user_id, person_id, remark) VALUES ($1, $2, $3)
		ON CONFLICT (user_id, person_id) DO UPDATE SET remark = EXCLUDED.remark`,
		userID, personID, remark)
	if isForeignKeyViolation(err) {
		return errPersonNotFound
	}
	return err
}

// Setting 读一项平台设置，没设过时返回空字符串。
func (s *Store) Setting(ctx context.Context, key string) (string, error) {
	var value string
	err := s.pool.QueryRow(ctx, `SELECT value FROM settings WHERE key = $1`, key).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return value, err
}

func (s *Store) SetSetting(ctx context.Context, key, value string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO settings (key, value) VALUES ($1, $2)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, key, value)
	return err
}

func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}

// ---- 菜单和功能权限授权 ----

// grantMap 是一个人的单独设置：模块 id → 菜单或功能权限 id → 是否允许。
type grantMap map[string]map[string]bool

// grants 是一个人对应用、菜单和功能权限的全部单独设置。Apps 是模块 id → 能不能用整个应用。
type grants struct {
	Apps  map[string]bool
	Menus grantMap
	Perms grantMap
}

func (s *Store) Grants(ctx context.Context, userID int64) (grants, error) {
	menus, err := s.grantMap(ctx, `SELECT module_id, menu_id, allowed FROM menu_grants WHERE user_id = $1`, userID)
	if err != nil {
		return grants{}, err
	}
	perms, err := s.grantMap(ctx, `SELECT module_id, perm_id, allowed FROM perm_grants WHERE user_id = $1`, userID)
	if err != nil {
		return grants{}, err
	}
	apps := map[string]bool{}
	rows, err := s.pool.Query(ctx, `SELECT module_id, allowed FROM app_grants WHERE user_id = $1`, userID)
	if err != nil {
		return grants{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var module string
		var allowed bool
		if err := rows.Scan(&module, &allowed); err != nil {
			return grants{}, err
		}
		apps[module] = allowed
	}
	return grants{Apps: apps, Menus: menus, Perms: perms}, rows.Err()
}

func (s *Store) grantMap(ctx context.Context, query string, userID int64) (grantMap, error) {
	rows, err := s.pool.Query(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	g := grantMap{}
	for rows.Next() {
		var module, id string
		var allowed bool
		if err := rows.Scan(&module, &id, &allowed); err != nil {
			return nil, err
		}
		if g[module] == nil {
			g[module] = map[string]bool{}
		}
		g[module][id] = allowed
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

// SetAppGrant 单独允许或禁止一个人使用整个应用；allowed 为 nil 表示恢复默认值。
func (s *Store) SetAppGrant(ctx context.Context, userID int64, module string, allowed *bool) error {
	if allowed == nil {
		_, err := s.pool.Exec(ctx, `DELETE FROM app_grants WHERE user_id = $1 AND module_id = $2`, userID, module)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO app_grants (user_id, module_id, allowed) VALUES ($1, $2, $3)
		ON CONFLICT (user_id, module_id) DO UPDATE SET allowed = EXCLUDED.allowed`,
		userID, module, *allowed)
	return err
}

// SetPermGrant 单独允许或禁止一项功能权限；allowed 为 nil 表示恢复默认值。
func (s *Store) SetPermGrant(ctx context.Context, userID int64, module, perm string, allowed *bool) error {
	if allowed == nil {
		_, err := s.pool.Exec(ctx,
			`DELETE FROM perm_grants WHERE user_id = $1 AND module_id = $2 AND perm_id = $3`, userID, module, perm)
		return err
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO perm_grants (user_id, module_id, perm_id, allowed) VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id, module_id, perm_id) DO UPDATE SET allowed = EXCLUDED.allowed`,
		userID, module, perm, *allowed)
	return err
}

// CheckPassword 校验用户名和密码，失败时返回 nil。
func (s *Store) CheckPassword(ctx context.Context, username, password string) (*User, error) {
	var u User
	var hash string
	err := s.pool.QueryRow(ctx,
		`SELECT id, username, display_name, roles, person_id, password_hash FROM users WHERE username = $1 AND NOT disabled`, username).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.Roles, &u.PersonID, &hash)
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
		SELECT u.id, u.username, u.display_name, u.roles, u.person_id, s.created_at, s.expires_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`, tokenHash).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.Roles, &u.PersonID, &created, &expires)
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

// ---- 活跃度统计 ----

// RecordBeat 记一次心跳：同一个人、同一个应用、同一分钟只算一分钟，open 为 true 时打开次数加一。
func (s *Store) RecordBeat(ctx context.Context, userID int64, app, device string, open bool, tz string) error {
	opens := 0
	if open {
		opens = 1
	}
	_, err := s.pool.Exec(ctx, `
		WITH ins AS (
			INSERT INTO activity (user_id, app, minute, device) VALUES ($1, $2, date_trunc('minute', now()), $3)
			ON CONFLICT DO NOTHING RETURNING 1
		)
		INSERT INTO activity_daily (day, user_id, app, minutes, opens)
		VALUES ((now() AT TIME ZONE $4)::date, $1, $2, (SELECT count(*) FROM ins), $5)
		ON CONFLICT (day, user_id, app) DO UPDATE
		SET minutes = activity_daily.minutes + EXCLUDED.minutes, opens = activity_daily.opens + EXCLUDED.opens`,
		userID, app, device, tz, opens)
	return err
}

// RecordLogin 记一次登录结果。用户名不存在时 user_id 为空。
func (s *Store) RecordLogin(ctx context.Context, username string, ok bool) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO login_events (user_id, ok) VALUES ((SELECT id FROM users WHERE username = $1), $2)`, username, ok)
	return err
}

func (s *Store) DeleteOldStats(ctx context.Context, before time.Time) error {
	if _, err := s.pool.Exec(ctx, `DELETE FROM activity WHERE minute < $1`, before); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM login_events WHERE at < $1`, before)
	return err
}

func (s *Store) ClearStats(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `TRUNCATE activity, activity_daily, login_events`)
	return err
}

type statsDay struct {
	Day     string `json:"day"`
	Users   int    `json:"users"`
	Minutes int    `json:"minutes"`
}

type statsApp struct {
	App     string `json:"app"`
	Name    string `json:"name"`
	Users   int    `json:"users"`
	Minutes int    `json:"minutes"`
	Opens   int    `json:"opens"`
}

type statsPerson struct {
	UserID      int64      `json:"userId"`
	DisplayName string     `json:"displayName"`
	Disabled    bool       `json:"disabled"`
	Minutes     int        `json:"minutes"`
	ActiveDays  int        `json:"activeDays"`
	LastActive  *time.Time `json:"lastActive"`
}

type statsDevice struct {
	Device  string `json:"device"`
	Minutes int    `json:"minutes"`
}

type statsReport struct {
	Enabled bool `json:"enabled"`
	Days    int  `json:"days"`
	// 今天、最近 7 天、最近 30 天用过平台的人数，今天的使用分钟数。
	TodayUsers   int `json:"todayUsers"`
	TodayMinutes int `json:"todayMinutes"`
	WeekUsers    int `json:"weekUsers"`
	MonthUsers   int `json:"monthUsers"`
	// 所选时间段里登录成功和失败的次数。
	LoginsOK     int           `json:"loginsOk"`
	LoginsFailed int           `json:"loginsFailed"`
	Daily        []statsDay    `json:"daily"`
	Apps         []statsApp    `json:"apps"`
	People       []statsPerson `json:"people"`
	Devices      []statsDevice `json:"devices"`
}

// StatsReport 汇总最近 days 天（含今天）的统计。日期按 tz 算。
func (s *Store) StatsReport(ctx context.Context, days int, tz string) (*statsReport, error) {
	r := &statsReport{Days: days, Daily: []statsDay{}, Apps: []statsApp{}, People: []statsPerson{}, Devices: []statsDevice{}}
	var today time.Time
	if err := s.pool.QueryRow(ctx, `SELECT (now() AT TIME ZONE $1)::date`, tz).Scan(&today); err != nil {
		return nil, err
	}
	// 日期都用字符串传给数据库再转成 date，不受数据库会话时区的影响。
	date := func(t time.Time) string { return t.Format(time.DateOnly) }
	from := date(today.AddDate(0, 0, -(days - 1)))
	// 汇总按天的表时，从哪天开始算有多少不同的人。
	users := func(since string) (int, error) {
		var n int
		err := s.pool.QueryRow(ctx, `SELECT count(DISTINCT user_id) FROM activity_daily WHERE day >= $1::date`, since).Scan(&n)
		return n, err
	}
	var err error
	if r.TodayUsers, err = users(date(today)); err != nil {
		return nil, err
	}
	if r.WeekUsers, err = users(date(today.AddDate(0, 0, -6))); err != nil {
		return nil, err
	}
	if r.MonthUsers, err = users(date(today.AddDate(0, 0, -29))); err != nil {
		return nil, err
	}
	if err := s.pool.QueryRow(ctx, `SELECT coalesce(sum(minutes), 0) FROM activity_daily WHERE day = $1::date`, date(today)).
		Scan(&r.TodayMinutes); err != nil {
		return nil, err
	}
	if err := s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE ok), count(*) FILTER (WHERE NOT ok) FROM login_events
		WHERE (at AT TIME ZONE $2)::date >= $1::date`, from, tz).Scan(&r.LoginsOK, &r.LoginsFailed); err != nil {
		return nil, err
	}

	// 每天一行，没人用的日子也有，人数和分钟数为 0。
	rows, err := s.pool.Query(ctx, `
		SELECT to_char(d, 'YYYY-MM-DD'), count(DISTINCT a.user_id), coalesce(sum(a.minutes), 0)
		FROM generate_series($1::date, $2::date, interval '1 day') d
		LEFT JOIN activity_daily a ON a.day = d::date
		GROUP BY d ORDER BY d`, from, date(today))
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var d statsDay
		if err := rows.Scan(&d.Day, &d.Users, &d.Minutes); err != nil {
			rows.Close()
			return nil, err
		}
		r.Daily = append(r.Daily, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.pool.Query(ctx, `
		SELECT app, count(DISTINCT user_id), sum(minutes), sum(opens) FROM activity_daily
		WHERE day >= $1::date GROUP BY app ORDER BY sum(minutes) DESC, sum(opens) DESC, app`, from)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var a statsApp
		if err := rows.Scan(&a.App, &a.Users, &a.Minutes, &a.Opens); err != nil {
			rows.Close()
			return nil, err
		}
		r.Apps = append(r.Apps, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 所有账号都列出来，好看出谁很久没来了。最近活跃时间来自明细，超过保留期的为空。
	rows, err = s.pool.Query(ctx, `
		SELECT u.id, u.display_name, u.disabled,
			coalesce((SELECT sum(minutes) FROM activity_daily a WHERE a.user_id = u.id AND a.day >= $1::date), 0),
			(SELECT count(DISTINCT day) FROM activity_daily a WHERE a.user_id = u.id AND a.day >= $1::date),
			(SELECT max(minute) FROM activity a WHERE a.user_id = u.id)
		FROM users u ORDER BY 4 DESC, u.id`, from)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var p statsPerson
		if err := rows.Scan(&p.UserID, &p.DisplayName, &p.Disabled, &p.Minutes, &p.ActiveDays, &p.LastActive); err != nil {
			rows.Close()
			return nil, err
		}
		r.People = append(r.People, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.pool.Query(ctx, `
		SELECT device, count(*) FROM activity WHERE (minute AT TIME ZONE $2)::date >= $1::date
		GROUP BY device ORDER BY count(*) DESC`, from, tz)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var d statsDevice
		if err := rows.Scan(&d.Device, &d.Minutes); err != nil {
			return nil, err
		}
		r.Devices = append(r.Devices, d)
	}
	return r, rows.Err()
}
