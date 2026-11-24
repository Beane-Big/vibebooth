package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// contactTestStore 在专用测试数据库内建立独立 schema，验证真实 SQL 和迁移，不触碰部署数据。
func contactTestStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("VIBEBOOTH_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set VIBEBOOTH_TEST_DATABASE_URL for contact integration tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("contacts_test_%d", time.Now().UnixNano())
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+name); err != nil {
		t.Fatal(err)
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = name
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close(); admin.Exec(ctx, "DROP SCHEMA "+name+" CASCADE"); admin.Close() })
	store := &Store{pool: pool}
	if err = store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	return store
}

// TestContactsUserIsolation 覆盖一对一迁移、联系人读取、精确添加、私人备注、旧接口隔离和删除后的重启行为。
func TestContactsUserIsolation(t *testing.T) {
	store := contactTestStore(t)
	ctx := context.Background()
	// owner、observer 还没有人员，Migrate 会补建；friend、stranger 各有一个人员。
	_, err := store.pool.Exec(ctx, `
        INSERT INTO persons (id,name,note,photo) VALUES (1,'朋友','',''),(2,'陌生人','','');
        INSERT INTO users (id,username,display_name,password_hash,email,person_id) VALUES
          (1,'owner','','unused','owner@example.com',NULL),
          (2,'friend','','unused','friend@example.com',1),
          (3,'stranger','','unused','stranger@example.com',2),
          (4,'observer','','unused','observer@example.com',NULL),
          (5,'disabled','','unused','disabled@example.com',NULL);
        UPDATE users SET disabled=true WHERE id=5;
        INSERT INTO contacts(owner_id,target_user_id,remark) VALUES(1,2,'旧备注');
        INSERT INTO person_remarks(user_id,person_id,remark) VALUES(1,1,'旧备注');
        SELECT setval(pg_get_serial_sequence('persons','id'), (SELECT max(id) FROM persons));`)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store}
	owner := &User{ID: 1}
	list := func(me *User) []contactView {
		t.Helper()
		w := httptest.NewRecorder()
		s.handleContacts(w, httptest.NewRequest(http.MethodGet, "/", nil), me)
		if w.Code != 200 {
			t.Fatalf("list: %d %s", w.Code, w.Body)
		}
		var out []contactView
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	// 一对一迁移：owner、observer 都补建了人员，姓名沿用显示名称（没有就账号）。
	initial := list(owner)
	if len(initial) != 1 || initial[0].Username != "friend" || initial[0].Name != "朋友" || initial[0].Remark != "旧备注" {
		t.Fatalf("list after migration: %+v", initial)
	}
	if len(list(&User{ID: 4})) != 0 {
		t.Fatal("another owner sees contacts")
	}

	// 精确添加：账号和邮箱都能解析到同一个用户；停用、不存在、自己都拒绝。
	for _, tc := range []struct {
		identifier string
		status     int
	}{
		{"stranger", 204}, {"stranger@example.com", 204}, {"unknown@example.com", 404},
		{"missing", 404}, {"disabled", 404}, {"owner", 400}, {"bad@", 400},
	} {
		w := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]string{"identifier": tc.identifier})
		s.handleAddContact(w, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(string(body))), owner)
		if w.Code != tc.status {
			t.Fatalf("add %s: %d %s", tc.identifier, w.Code, w.Body)
		}
	}
	// 只有 friend 和 stranger 两个联系人。
	got := list(owner)
	if len(got) != 2 {
		t.Fatalf("expected 2 contacts, got %d: %+v", len(got), got)
	}

	// 备注：别人不能改，本人能改，改了以后旧成员备注接口同步。
	id := fmt.Sprint(initial[0].ID)
	remark := func(me *User, value string) int {
		w := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]string{"remark": value})
		req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(string(body)))
		req.SetPathValue("id", id)
		s.handleContactRemark(w, req, me)
		return w.Code
	}
	if remark(&User{ID: 4}, "偷改") != 404 || remark(owner, "新备注") != 204 {
		t.Fatal("remark ownership")
	}
	if list(owner)[0].Remark != "新备注" {
		t.Fatal("remark not saved")
	}
	members, err := store.ListMembers(ctx, 1)
	if err != nil || len(members) != 3 || members[0].Remark != "新备注" {
		t.Fatalf("legacy members: %+v %v", members, err)
	}
	observer, err := store.UserByID(ctx, 4)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.SetRemark(ctx, 1, *observer.PersonID, "越权"); err != errPersonNotFound {
		t.Fatalf("legacy remark allowed stranger: %v", err)
	}
	if remark(owner, "") != 204 {
		t.Fatal("clear remark")
	}
	if err = store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if list(owner)[0].Remark != "" {
		t.Fatal("migration restored cleared remark")
	}

	// 删除：别人删不掉，本人删掉后重启不会复活。
	req := httptest.NewRequest(http.MethodDelete, "/", nil)
	req.SetPathValue("id", id)
	w := httptest.NewRecorder()
	s.handleDeleteContact(w, req, &User{ID: 4})
	if w.Code != 404 {
		t.Fatal("another user deleted contact")
	}
	w = httptest.NewRecorder()
	s.handleDeleteContact(w, req, owner)
	if w.Code != 204 {
		t.Fatal("delete failed")
	}
	if err = store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if len(list(owner)) != 1 {
		t.Fatal("deleted contact restored on restart")
	}
}

// TestPersonsOneToOne 验证每个账号都有自己的人员，同一人员的多个账号会被拆开。
func TestPersonsOneToOne(t *testing.T) {
	store := contactTestStore(t)
	ctx := context.Background()
	_, err := store.pool.Exec(ctx, `
        INSERT INTO persons (id,name) VALUES (1,'共享');
        INSERT INTO users (id,username,display_name,password_hash,person_id) VALUES
          (1,'alice','','unused',1),
          (2,'bob','','unused',1),
          (3,'carol','','unused',NULL);
        SELECT setval(pg_get_serial_sequence('persons','id'), (SELECT max(id) FROM persons));`)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	rows, err := store.pool.Query(ctx, `SELECT id, person_id, display_name FROM users ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type row struct {
		id, personID int64
		displayName  string
	}
	var users []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.personID, &r.displayName); err != nil {
			t.Fatal(err)
		}
		users = append(users, r)
	}
	if len(users) != 3 {
		t.Fatalf("users: %+v", users)
	}
	seen := map[int64]bool{}
	for _, u := range users {
		if u.personID == 0 {
			t.Fatalf("user %d has no person: %+v", u.id, u)
		}
		if seen[u.personID] {
			t.Fatalf("person %d shared by multiple accounts: %+v", u.personID, users)
		}
		seen[u.personID] = true
		if u.displayName == "" {
			t.Fatalf("user %d has empty display name", u.id)
		}
	}
}

// TestContactsMutualFriendsAndExtAPI 验证双向好友请求、同意/拒绝、互删以及对外联系人与批量资料接口。
func TestContactsMutualFriendsAndExtAPI(t *testing.T) {
	store := contactTestStore(t)
	ctx := context.Background()
	_, err := store.pool.Exec(ctx, `
        INSERT INTO users (id,username,display_name,password_hash,email) VALUES
          (1,'alice','爱丽丝','unused','alice@example.com'),
          (2,'bob','鲍勃','unused','bob@example.com'),
          (3,'carol','卡罗尔','unused','carol@example.com');`)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	s := &Server{store: store}
	alice, bob, carol := &User{ID: 1}, &User{ID: 2}, &User{ID: 3}

	// Alice 添加 Bob -> Alice 侧为 pending，Bob 收到好友请求。
	w := httptest.NewRecorder()
	s.handleAddContact(w, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"identifier":"bob"}`)), alice)
	if w.Code != 204 {
		t.Fatalf("alice add bob: %d %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	s.handleContacts(w, httptest.NewRequest(http.MethodGet, "/", nil), alice)
	var aliceContacts []contactView
	json.Unmarshal(w.Body.Bytes(), &aliceContacts)
	if len(aliceContacts) != 1 || aliceContacts[0].Status != "pending" || aliceContacts[0].UserID != 2 {
		t.Fatalf("alice contacts before accept: %+v", aliceContacts)
	}

	w = httptest.NewRecorder()
	s.handleContactRequests(w, httptest.NewRequest(http.MethodGet, "/", nil), bob)
	var bobReqs []contactRequestView
	json.Unmarshal(w.Body.Bytes(), &bobReqs)
	if len(bobReqs) != 1 || bobReqs[0].UserID != 1 {
		t.Fatalf("bob requests: %+v", bobReqs)
	}

	// 未同意前，ext/v1 mutual=1 为空。
	req := httptest.NewRequest(http.MethodGet, "/?mutual=1", nil)
	req.SetPathValue("id", "1")
	w = httptest.NewRecorder()
	s.handleExtUserContacts(w, req)
	var extMutual []extUser
	json.Unmarshal(w.Body.Bytes(), &extMutual)
	if len(extMutual) != 0 {
		t.Fatalf("expected 0 mutual before accept, got %+v", extMutual)
	}

	// Bob 同意请求 -> 双方互为好友。
	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req.SetPathValue("id", fmt.Sprint(bobReqs[0].ID))
	w = httptest.NewRecorder()
	s.handleAcceptContactRequest(w, req, bob)
	if w.Code != 204 {
		t.Fatalf("bob accept: %d %s", w.Code, w.Body)
	}

	req = httptest.NewRequest(http.MethodGet, "/?mutual=1", nil)
	req.SetPathValue("id", "1")
	w = httptest.NewRecorder()
	s.handleExtUserContacts(w, req)
	json.Unmarshal(w.Body.Bytes(), &extMutual)
	if len(extMutual) != 1 || extMutual[0].ID != 2 || !extMutual[0].Mutual {
		t.Fatalf("expected mutual bob, got %+v", extMutual)
	}

	// Carol 添加 Alice 后被拒绝 -> Carol 侧记录删除。
	w = httptest.NewRecorder()
	s.handleAddContact(w, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"identifier":"alice"}`)), carol)
	if w.Code != 204 {
		t.Fatalf("carol add alice: %d", w.Code)
	}
	w = httptest.NewRecorder()
	s.handleContactRequests(w, httptest.NewRequest(http.MethodGet, "/", nil), alice)
	var aliceReqs []contactRequestView
	json.Unmarshal(w.Body.Bytes(), &aliceReqs)
	if len(aliceReqs) != 1 || aliceReqs[0].UserID != 3 {
		t.Fatalf("alice requests: %+v", aliceReqs)
	}
	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req.SetPathValue("id", fmt.Sprint(aliceReqs[0].ID))
	w = httptest.NewRecorder()
	s.handleRejectContactRequest(w, req, alice)
	if w.Code != 204 {
		t.Fatalf("alice reject: %d", w.Code)
	}

	// 批量查询 ext/v1/users?ids=1,2&viewer=1。
	req = httptest.NewRequest(http.MethodGet, "/?ids=1,2&viewer=1", nil)
	w = httptest.NewRecorder()
	s.handleExtUsers(w, req)
	var batch []extUser
	json.Unmarshal(w.Body.Bytes(), &batch)
	if len(batch) != 2 || batch[0].ID != 1 || batch[1].ID != 2 || !batch[1].Mutual {
		t.Fatalf("ext users batch: %+v", batch)
	}
}
