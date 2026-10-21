package main

import (
	"context"
	"database/sql"
	"errors"
	"time"

	_ "modernc.org/sqlite"
)

// Person 是一条人员信息。其他模块只保存 id，需要名字时调用对外接口。
type Person struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	Note      string    `json:"note"`
	Photo     string    `json:"photo"` // 压缩后的 JPEG 头像（data URL），没有时为空
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS people (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	name       TEXT NOT NULL,
	note       TEXT NOT NULL DEFAULT '',
	photo      TEXT NOT NULL DEFAULT '',
	created_at TIMESTAMP NOT NULL,
	updated_at TIMESTAMP NOT NULL
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

var errNotFound = errors.New("人员不存在")

func (s *Store) List(ctx context.Context) ([]Person, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, note, photo, created_at, updated_at FROM people ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []Person{}
	for rows.Next() {
		var p Person
		if err := rows.Scan(&p.ID, &p.Name, &p.Note, &p.Photo, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		list = append(list, p)
	}
	return list, rows.Err()
}

func (s *Store) Get(ctx context.Context, id int64) (*Person, error) {
	var p Person
	err := s.db.QueryRowContext(ctx, `SELECT id, name, note, photo, created_at, updated_at FROM people WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.Note, &p.Photo, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Store) Create(ctx context.Context, name, note, photo string) (*Person, error) {
	now := time.Now().UTC()
	res, err := s.db.ExecContext(ctx,
		`INSERT INTO people (name, note, photo, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`, name, note, photo, now, now)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return &Person{ID: id, Name: name, Note: note, Photo: photo, CreatedAt: now, UpdatedAt: now}, nil
}

func (s *Store) Update(ctx context.Context, id int64, name, note, photo string) (*Person, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE people SET name = ?, note = ?, photo = ?, updated_at = ? WHERE id = ?`, name, note, photo, time.Now().UTC(), id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, errNotFound
	}
	return s.Get(ctx, id)
}

func (s *Store) UpdatePhoto(ctx context.Context, id int64, photo string) (*Person, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE people SET photo = ?, updated_at = ? WHERE id = ?`, photo, time.Now().UTC(), id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, errNotFound
	}
	return s.Get(ctx, id)
}

func (s *Store) Delete(ctx context.Context, id int64) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM people WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errNotFound
	}
	return nil
}
