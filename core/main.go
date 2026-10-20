// 平台核心：登录与会话、给网关做 forwardAuth、签发模块令牌、应用注册表。
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type config struct {
	Addr          string
	DatabaseURL   string
	DataDir       string
	ModulesDir    string
	AdminUser     string
	AdminPassword string
	CookieSecure  bool
}

func loadConfig() config {
	return config{
		Addr:          env("ADDR", ":8080"),
		DatabaseURL:   os.Getenv("DATABASE_URL"),
		DataDir:       env("DATA_DIR", "/data"),
		ModulesDir:    env("MODULES_DIR", "/modules"),
		AdminUser:     env("ADMIN_USERNAME", "admin"),
		AdminPassword: os.Getenv("ADMIN_PASSWORD"),
		CookieSecure:  os.Getenv("COOKIE_SECURE") == "true",
	}
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	cfg := loadConfig()
	ctx := context.Background()

	pool, err := pgxpool.New(ctx, cfg.DatabaseURL)
	if err != nil {
		fatal("连接数据库失败", err)
	}
	defer pool.Close()

	store := &Store{pool: pool}
	if err := store.Migrate(ctx); err != nil {
		fatal("数据库迁移失败", err)
	}
	if err := store.EnsureAdmin(ctx, cfg.AdminUser, cfg.AdminPassword); err != nil {
		fatal("初始化管理员失败", err)
	}

	key, err := loadOrCreateKey(filepath.Join(cfg.DataDir, "jwt.pem"))
	if err != nil {
		fatal("加载签名密钥失败", err)
	}

	registry := NewRegistry(cfg.ModulesDir)
	registry.Load()

	s := &Server{
		cfg:      cfg,
		store:    store,
		key:      key,
		registry: registry,
		limiter:  newLoginLimiter(10, 15*time.Minute),
	}
	go s.cleanupSessions(ctx)

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           s.routes(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
	}
	slog.Info("平台核心已启动", "addr", cfg.Addr)
	if err := srv.ListenAndServe(); err != nil {
		fatal("服务退出", err)
	}
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/platform/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/platform/auth/logout", s.handleLogout)
	// Traefik 的 forwardAuth 用 GET 调用，但这里不限制方法，避免版本差异。
	mux.HandleFunc("/api/platform/auth/verify", s.handleVerify)
	mux.HandleFunc("GET /api/platform/.well-known/jwks.json", s.handleJWKS)
	mux.HandleFunc("GET /api/platform/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/platform/me", s.requireUser(s.handleMe))
	mux.HandleFunc("GET /api/platform/apps", s.requireUser(s.handleApps))
	mux.HandleFunc("GET /api/platform/apps/{id}/icon", s.requireUser(s.handleAppIcon))
	mux.HandleFunc("POST /api/platform/registry/reload", s.requireRole("admin", s.handleReload))
	return mux
}

func fatal(msg string, err error) {
	slog.Error(msg, "err", err)
	os.Exit(1)
}
