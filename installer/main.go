// 模块安装器：校验模块包、导入镜像、以独立的 Compose 项目启动模块，并把清单写进模块卷供平台核心读取。
// 它是平台里唯一能创建容器的服务，经过单独的 socket-proxy 访问 Docker。
//
// 同一个程序也是命令行工具：模块仓库里的 scripts/vb.mjs 用它打包和安装，平台的 scripts/module 用它管理已装的模块。
//
//	installer pack <模块目录> <images.tar> <输出.zip>
//	installer install <模块包.zip> [--allow-privileges]
//	installer uninstall <id> [--purge]
//	installer list
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/Beane-Big/vibebooth/packages/modpkg"
	"github.com/Beane-Big/vibebooth/packages/sdk-go/auth"
)

func main() {
	in := &Installer{dir: env("MODULES_DIR", "/modules"), healthTimeout: 60 * time.Second}
	if len(os.Args) > 1 {
		os.Exit(runCLI(in, os.Args[1:]))
	}

	verifier := auth.NewVerifier(env("JWKS_URL", "http://core:8080/api/platform/.well-known/jwks.json"), "installer")
	srv := &http.Server{
		Addr:              ":8000",
		Handler:           (&server{installer: in}).routes(verifier),
		ReadHeaderTimeout: 10 * time.Second,
		// 上传模块包和启动容器都可能要几分钟。
		ReadTimeout:  10 * time.Minute,
		WriteTimeout: 10 * time.Minute,
	}
	slog.Info("模块安装器已启动", "addr", srv.Addr)
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("服务退出", "err", err)
		os.Exit(1)
	}
}

func runCLI(in *Installer, args []string) int {
	ctx := context.Background()
	var err error
	switch {
	case args[0] == "pack" && len(args) == 4:
		err = modpkg.Pack(args[1], args[2], args[3])
		if err == nil {
			fmt.Println("已生成", args[3])
		}
	case args[0] == "install" && (len(args) == 2 || len(args) == 3 && args[2] == "--allow-privileges"):
		_, err = in.Install(ctx, args[1], len(args) == 3, os.Stdout)
	case args[0] == "uninstall" && (len(args) == 2 || len(args) == 3 && args[2] == "--purge"):
		err = in.Uninstall(ctx, args[1], len(args) == 3, os.Stdout)
	case args[0] == "list" && len(args) == 1:
		var list []Installed
		if list, err = in.List(ctx); err == nil {
			enc := json.NewEncoder(os.Stdout)
			enc.SetIndent("", "  ")
			enc.Encode(list)
		}
	default:
		fmt.Fprintln(os.Stderr, "用法: installer pack <模块目录> <images.tar> <输出.zip> | install <模块包.zip> [--allow-privileges] | uninstall <id> [--purge] | list")
		return 2
	}
	var priv *PrivilegeError
	if errors.As(err, &priv) {
		fmt.Fprintf(os.Stderr, "错误: %v。确认要安装的话，加上 --allow-privileges 再运行一次\n", err)
		return 1
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		return 1
	}
	return 0
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
