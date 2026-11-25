package main

import (
	"archive/zip"
	"bytes"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func resolveSkillDir() string {
	if v := strings.TrimSpace(os.Getenv("SKILL_DIR")); v != "" {
		return v
	}
	for _, candidate := range []string{
		"/usr/local/share/vibebooth/skill",
		filepath.Join("..", "skills", "vibebooth-app-dev"),
		filepath.Join("skills", "vibebooth-app-dev"),
	} {
		if st, err := os.Stat(filepath.Join(candidate, "SKILL.md")); err == nil && !st.IsDir() {
			return candidate
		}
	}
	return ""
}

func zipSkillDir(dir string) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		hdr.Name = "vibebooth-app-dev/" + filepath.ToSlash(rel)
		hdr.Method = zip.Deflate
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(w, f)
		return err
	})
	if err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (h *handlers) downloadSkill(w http.ResponseWriter, _ *http.Request) {
	dir := resolveSkillDir()
	if dir == "" {
		writeError(w, http.StatusNotFound, "未找到开发规范 Skill 文件")
		return
	}
	data, err := zipSkillDir(dir)
	if err != nil {
		internalError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="vibebooth-app-dev-skill.zip"`)
	_, _ = w.Write(data)
}
