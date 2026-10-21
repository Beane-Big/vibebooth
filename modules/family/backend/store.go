package main

import (
	"context"
	"database/sql"

	_ "modernc.org/sqlite"
)

// Store 只保存每个人的分数。人员信息归人员管理模块所有，这里只用 person_id 关联。
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS scores (
	person_id INTEGER PRIMARY KEY,
	score     INTEGER NOT NULL DEFAULT 0
);
`

// OpenStore 打开模块自己的 SQLite 文件；数据库只属于本模块，放在本模块的卷里。
func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	// SQLite 同一时间只允许一个写入者，单连接可以避免 "database is locked"。
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

// Scores 返回有分数记录的人员，key 是 person_id；没有记录的人按 0 分处理。
func (s *Store) Scores(ctx context.Context) (map[int64]int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT person_id, score FROM scores`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	scores := map[int64]int{}
	for rows.Next() {
		var id int64
		var score int
		if err := rows.Scan(&id, &score); err != nil {
			return nil, err
		}
		scores[id] = score
	}
	return scores, rows.Err()
}

// Change 在原分数上加减 delta 并返回新分数；在数据库里原子地累加，多台设备同时打分也不会丢分。
func (s *Store) Change(ctx context.Context, personID int64, delta int) (int, error) {
	var score int
	err := s.db.QueryRowContext(ctx, `
		INSERT INTO scores (person_id, score) VALUES (?, ?)
		ON CONFLICT (person_id) DO UPDATE SET score = score + excluded.score
		RETURNING score`, personID, delta).Scan(&score)
	return score, err
}

// Reset 把所有人的分数清零。
func (s *Store) Reset(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM scores`)
	return err
}
