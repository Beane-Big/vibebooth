package main

import (
	"context"
	"errors"
	"log/slog"
	"strings"
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
	// PersonID 是这个账号对应的人员 id。账号和人员一一对应，每个账号都有自己的人员。
	PersonID *int64 `json:"personId"`
}

func (u *User) Name() string {
	if u.DisplayName != "" {
		return u.DisplayName
	}
	return u.Username
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
CREATE TABLE IF NOT EXISTS email_auth_codes (
  purpose TEXT NOT NULL,
  email TEXT NOT NULL,
  digest BYTEA NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (purpose, email)
);
CREATE TABLE IF NOT EXISTS sessions (
	token_hash BYTEA PRIMARY KEY,
	user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	expires_at TIMESTAMPTZ NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS self_registered BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_subject TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_subject_idx ON users (google_subject) WHERE google_subject IS NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
-- 早期自助账号使用已规范化的邮箱作为 username；保留其原登录地址。
UPDATE users SET email = username
	WHERE email IS NULL AND (self_registered OR email_verified OR google_subject IS NOT NULL)
		AND strpos(username, '@') > 0;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users (email) WHERE email IS NOT NULL;
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
CREATE TABLE IF NOT EXISTS app_access (
	module_id TEXT PRIMARY KEY,
	version TEXT NOT NULL,
	scope TEXT NOT NULL CHECK (scope IN ('public', 'signed-in'))
);
CREATE TABLE IF NOT EXISTS contacts (
	id BIGSERIAL PRIMARY KEY,
	owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	target_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
	target_person_id BIGINT REFERENCES persons(id) ON DELETE CASCADE,
	email TEXT,
	CHECK (num_nonnulls(target_user_id, target_person_id, email) = 1),
	CHECK (owner_id <> target_user_id),
	UNIQUE (owner_id, target_user_id),
	UNIQUE (owner_id, target_person_id),
	UNIQUE (owner_id, email)
);
-- 只迁移一次。以后新增人员或移除联系人都不会重新导入。
WITH migration AS (
	INSERT INTO settings (key, value) VALUES ('contacts_seed_v1', 'done')
	ON CONFLICT (key) DO NOTHING RETURNING key
)
INSERT INTO contacts (owner_id, target_person_id)
SELECT u.id, p.id FROM migration CROSS JOIN users u CROSS JOIN persons p
WHERE u.person_id IS NOT NULL AND u.person_id <> p.id
ON CONFLICT DO NOTHING;
-- 联系人以平台账号为目标；旧人员和邮箱记录保留，只有能匹配账号的条目迁移到新列表。
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS remark TEXT NOT NULL DEFAULT '';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- 已经通过账号添加的联系人也沿用原私人备注，不覆盖后来写在联系人上的内容。
UPDATE contacts c SET remark=pr.remark
FROM users u, person_remarks pr
WHERE c.target_user_id=u.id AND pr.person_id=u.person_id AND pr.user_id=c.owner_id AND c.remark=''
AND NOT EXISTS (SELECT 1 FROM settings WHERE key='contacts_users_v2');
WITH migration AS (
  INSERT INTO settings (key, value) VALUES ('contacts_users_v2', 'done')
  ON CONFLICT (key) DO NOTHING RETURNING key
)
INSERT INTO contacts (owner_id, target_user_id, remark)
SELECT DISTINCT ON (c.owner_id, u.id) c.owner_id, u.id, COALESCE(pr.remark, '')
FROM migration CROSS JOIN contacts c
JOIN users u ON u.person_id=c.target_person_id OR (c.email IS NOT NULL AND u.email=c.email)
LEFT JOIN person_remarks pr ON pr.user_id=c.owner_id AND pr.person_id=u.person_id
WHERE u.id<>c.owner_id AND NOT u.disabled
ORDER BY c.owner_id, u.id, c.id
ON CONFLICT (owner_id, target_user_id) DO NOTHING;
-- 双向好友迁移：历史数据中互为联系人的记录标记为 accepted。
WITH migration AS (
  INSERT INTO settings (key, value) VALUES ('contacts_mutual_v3', 'done')
  ON CONFLICT (key) DO NOTHING RETURNING key
)
UPDATE contacts c SET status = 'accepted'
FROM migration, contacts rev
WHERE c.target_user_id IS NOT NULL
  AND rev.owner_id = c.target_user_id
  AND rev.target_user_id = c.owner_id;
-- 关联了人员的账号，显示名称就是人员姓名。改姓名、关联账号时会一起改；这里把以前不一致的数据对齐一次。
UPDATE users u SET display_name = p.name FROM persons p WHERE p.id = u.person_id AND u.display_name <> p.name;
-- 平台通知中心：站内通知记录与外部推送通道（支持个人通道与系统级管理员通道）。
CREATE TABLE IF NOT EXISTS notifications (
	id         BIGSERIAL PRIMARY KEY,
	user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	app_id     TEXT NOT NULL DEFAULT 'platform',
	title      TEXT NOT NULL,
	body       TEXT NOT NULL DEFAULT '',
	link       TEXT NOT NULL DEFAULT '',
	dedup_key  TEXT NOT NULL DEFAULT '',
	read_at    TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx ON notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_dedup_idx ON notifications (user_id, app_id, dedup_key) WHERE dedup_key <> '' AND read_at IS NULL;

CREATE TABLE IF NOT EXISTS notification_channels (
	id         BIGSERIAL PRIMARY KEY,
	user_id    BIGINT REFERENCES users(id) ON DELETE CASCADE,
	kind       TEXT NOT NULL CHECK (kind IN ('webhook', 'bark', 'wecom', 'feishu', 'dingtalk')),
	name       TEXT NOT NULL DEFAULT '',
	target_url TEXT NOT NULL,
	enabled    BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notification_channels_user_idx ON notification_channels (user_id);

-- 每位登录用户自己的首页应用排序与隐藏列表（builtin:<id> 表示内置应用，<id> 表示模块）。
CREATE TABLE IF NOT EXISTS user_home_prefs (
	user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	app_order   TEXT[] NOT NULL DEFAULT '{}',
	hidden_apps TEXT[] NOT NULL DEFAULT '{}',
	updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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
	if _, err = s.pool.Exec(ctx, schema); err != nil {
		return err
	}
	return s.ensurePersonsOneToOne(ctx)
}

// ensurePersonsOneToOne 让账号和人员一一对应：给没有人员的账号补建人员，把同一个人员的多个账号拆开，
// 并对齐显示名称（人员姓名，没有姓名时用账号）。它在每次启动时运行，收敛后就是空操作。
func (s *Store) ensurePersonsOneToOne(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// 1) 给没有人员的账号各建一个人员并关联，姓名用显示名称，没有就用账号。
	rows, err := tx.Query(ctx, `SELECT id, username, display_name FROM users WHERE person_id IS NULL ORDER BY id`)
	if err != nil {
		return err
	}
	type unlinked struct {
		id          int64
		username    string
		displayName string
	}
	var pending []unlinked
	for rows.Next() {
		var u unlinked
		if err := rows.Scan(&u.id, &u.username, &u.displayName); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, u)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, u := range pending {
		name := strings.TrimSpace(u.displayName)
		if name == "" {
			name = u.username
		}
		var personID int64
		if err := tx.QueryRow(ctx, `INSERT INTO persons (name) VALUES ($1) RETURNING id`, name).Scan(&personID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE users SET person_id=$2, display_name=$3 WHERE id=$1`, u.id, personID, name); err != nil {
			return err
		}
	}

	// 2) 一个人员有多个账号时，保留 id 最小的账号，其余账号各补建自己的人员。
	rows, err = tx.Query(ctx, `SELECT person_id, array_agg(id ORDER BY id) FROM users WHERE person_id IS NOT NULL GROUP BY person_id HAVING count(*) > 1 ORDER BY person_id`)
	if err != nil {
		return err
	}
	type shared struct {
		personID int64
		ids      []int64
	}
	var shares []shared
	for rows.Next() {
		var m shared
		if err := rows.Scan(&m.personID, &m.ids); err != nil {
			rows.Close()
			return err
		}
		shares = append(shares, m)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, m := range shares {
		for _, uid := range m.ids[1:] {
			var name string
			if err := tx.QueryRow(ctx, `SELECT COALESCE(NULLIF(display_name, ''), username) FROM users WHERE id=$1`, uid).Scan(&name); err != nil {
				return err
			}
			var personID int64
			if err := tx.QueryRow(ctx, `INSERT INTO persons (name) VALUES ($1) RETURNING id`, name).Scan(&personID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE users SET person_id=$2 WHERE id=$1`, uid, personID); err != nil {
				return err
			}
		}
	}

	// 3) 对齐显示名称：等于人员姓名，人员没有姓名时用账号。
	_, err = tx.Exec(ctx, `UPDATE users u SET display_name = COALESCE(NULLIF(p.name, ''), u.username)
		FROM persons p WHERE p.id = u.person_id AND u.display_name <> COALESCE(NULLIF(p.name, ''), u.username)`)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
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
	_, err := s.CreateUser(ctx, username, "", password, true)
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

// CreateUser 新建账号，并自动给它创建一个一一对应的人员（姓名用显示名称，没有就用账号）。
func (s *Store) CreateUser(ctx context.Context, username, displayName, password string, admin bool) (*User, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(displayName)
	if name == "" {
		name = username
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var personID int64
	if err := tx.QueryRow(ctx, `INSERT INTO persons (name) VALUES ($1) RETURNING id`, name).Scan(&personID); err != nil {
		return nil, err
	}
	u := &User{Username: username, DisplayName: name, Roles: rolesFor(admin), PersonID: &personID}
	err = tx.QueryRow(ctx,
		`INSERT INTO users (username, display_name, password_hash, roles, person_id)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (username) DO NOTHING RETURNING id, display_name`,
		username, name, string(hash), u.Roles, personID).Scan(&u.ID, &u.DisplayName)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errUsernameTaken
	}
	if err != nil {
		return nil, err
	}
	return u, tx.Commit(ctx)
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

// UpdateUser 只更新管理员角色和停用状态，不写入账号资料。
// 停用时删除这个人的全部会话，让他立即退出。
func (s *Store) UpdateUser(ctx context.Context, id int64, admin, disabled bool) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET roles = CASE WHEN NOT $4 AND (email_verified OR self_registered) THEN '{}'::text[] ELSE $2 END, disabled = $3
		 WHERE id = $1`,
		id, rolesFor(admin), disabled, admin)
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

// DeletePerson 已移除：账号和人员一一对应，人员随账号一起创建和管理，不再单独删除人员。
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
        WHERE p.id = (SELECT person_id FROM users WHERE id=$1) OR EXISTS (
          SELECT 1 FROM contacts c JOIN users u ON u.id=c.target_user_id
          WHERE c.owner_id=$1 AND u.person_id=p.id AND NOT u.disabled
        )
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
// SetRemark 保留旧成员备注接口，但必须是本人或已经添加的账号关联人员。
func (s *Store) SetRemark(ctx context.Context, userID, personID int64, remark string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id int64
	err = tx.QueryRow(ctx, `INSERT INTO person_remarks (user_id, person_id, remark)
        SELECT $1, p.id, $3 FROM persons p WHERE p.id=$2 AND (
            p.id=(SELECT person_id FROM users WHERE id=$1) OR EXISTS (
                SELECT 1 FROM contacts c JOIN users u ON u.id=c.target_user_id
                WHERE c.owner_id=$1 AND u.person_id=p.id AND NOT u.disabled
            ))
        ON CONFLICT (user_id, person_id) DO UPDATE SET remark=excluded.remark
        RETURNING person_id`, userID, personID, remark).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return errPersonNotFound
	}
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE contacts c SET remark=$3 FROM users u
        WHERE c.owner_id=$1 AND c.target_user_id=u.id AND u.person_id=$2`, userID, personID, remark)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
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

// SettingsByKeys 一次读取多项设置，返回的 map 只包含数据库里已有记录的键，调用方据此区分“未设置”和“显式设为空”。
func (s *Store) SettingsByKeys(ctx context.Context, keys ...string) (map[string]string, error) {
	out := make(map[string]string, len(keys))
	if len(keys) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT key, value FROM settings WHERE key = ANY($1)`, keys)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
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
	// Scopes 保存当前平台访问范围，按模块版本计算默认权限，不写入个人授权记录。
	Scopes map[string]appAccess
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
	if err := rows.Err(); err != nil {
		return grants{}, err
	}
	rows.Close()
	scopes, err := s.appScopes(ctx)
	if err != nil {
		return grants{}, err
	}
	return grants{Apps: apps, Menus: menus, Perms: perms, Scopes: scopes}, nil
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
	user, _, err := s.checkPassword(ctx, username, password)
	return user, err
}

func (s *Store) checkPassword(ctx context.Context, username, password string) (*User, string, error) {
	var u User
	var hash string
	err := s.pool.QueryRow(ctx,
		`SELECT id, username, display_name, roles, person_id, password_hash FROM users WHERE username = $1 AND NOT disabled`, username).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.Roles, &u.PersonID, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		// 用户不存在时也做一次比较，避免通过响应时间判断用户名是否存在。
		bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	if hash == "" {
		bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return nil, "", nil
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return nil, "", nil
	}
	return &u, hash, nil
}

// CheckAdminPasswordByID 供内部服务（如安装器恢复数据前）二次校验管理员密码。
func (s *Store) CheckAdminPasswordByID(ctx context.Context, userID int64, password string) (bool, error) {
	var hash string
	var roles []string
	err := s.pool.QueryRow(ctx,
		`SELECT password_hash, roles FROM users WHERE id = $1 AND NOT disabled`, userID).
		Scan(&hash, &roles)
	if errors.Is(err, pgx.ErrNoRows) {
		bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if hash == "" || !hasAnyRole(roles, []string{"admin"}) {
		bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return false, nil
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil, nil
}

var dummyHash, _ = bcrypt.GenerateFromPassword([]byte("dummy-password"), bcrypt.DefaultCost)

func (s *Store) CreateSession(ctx context.Context, tokenHash []byte, userID int64, passwordHash string, expires time.Time) (bool, error) {
	// 锁定账号行，让会话创建与密码重置串行。重置先完成时旧摘要无法匹配；
	// 会话先创建时，重置会在更新账号后删掉这条会话。
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (token_hash, user_id, expires_at)
		SELECT $1, id, $3 FROM users
		WHERE id = $2 AND password_hash = $4 AND NOT disabled
		FOR UPDATE`, tokenHash, userID, expires, passwordHash)
	return tag.RowsAffected() == 1, err
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
		SELECT u.id, COALESCE(NULLIF(u.display_name, ''), u.username), u.disabled,
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
