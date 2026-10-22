package main

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
)

// Docker 调用 docker 命令行。DOCKER_HOST 指向只给安装器用的 socket-proxy，见 docker-compose.yml。
type Docker struct{}

func (Docker) run(ctx context.Context, log io.Writer, stdin io.Reader, args ...string) error {
	fmt.Fprintf(log, "$ docker %s\n", strings.Join(args, " "))
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Stdin = stdin
	cmd.Stdout = log
	cmd.Stderr = log
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker %s 失败: %w", args[0], err)
	}
	return nil
}

// Load 导入 docker save 导出的镜像。
func (d Docker) Load(ctx context.Context, log io.Writer, images io.Reader) error {
	return d.run(ctx, log, images, "load")
}

// Up 以独立的 Compose 项目启动模块；--remove-orphans 删掉新版本里已经不存在的服务。
func (d Docker) Up(ctx context.Context, log io.Writer, project, file string) error {
	return d.run(ctx, log, nil, "compose", "-p", project, "-f", file, "up", "-d", "--remove-orphans")
}

// Down 停止并删除模块的容器和镜像；purge 为 true 时连数据卷一起删除。
func (d Docker) Down(ctx context.Context, log io.Writer, project, file string, purge bool) error {
	args := []string{"compose", "-p", project, "-f", file, "down", "--remove-orphans", "--rmi", "all"}
	if purge {
		args = append(args, "--volumes")
	}
	return d.run(ctx, log, nil, args...)
}

// Logs 把模块容器最近的日志写进安装日志，安装失败时方便排查。
func (d Docker) Logs(ctx context.Context, log io.Writer, project, file string) {
	d.run(ctx, log, nil, "compose", "-p", project, "-f", file, "logs", "--no-color", "--tail", "50")
}

// RemoveImages 删除指定的镜像，升级失败回滚后用来清掉新版本的镜像。
func (d Docker) RemoveImages(ctx context.Context, log io.Writer, images []string) {
	d.run(ctx, log, nil, append([]string{"image", "rm"}, images...)...)
}

// RemoveOldImages 删除模块旧版本的镜像，只保留当前版本，避免每次升级都多占一份磁盘。
// 改名前用 hp- 前缀的旧镜像也一起删掉。
func (d Docker) RemoveOldImages(ctx context.Context, log io.Writer, keep []string) {
	repo := func(image string) string { return image[:strings.LastIndex(image, ":")] }
	for _, image := range keep {
		legacy := legacyImagePrefix + strings.TrimPrefix(repo(image), imagePrefix)
		for _, r := range []string{repo(image), legacy} {
			out, err := exec.CommandContext(ctx, "docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}", r).Output()
			if err != nil {
				continue
			}
			for _, old := range strings.Fields(string(out)) {
				if old != image && !strings.HasSuffix(old, ":<none>") {
					d.run(ctx, log, nil, "image", "rm", old)
				}
			}
		}
	}
}
