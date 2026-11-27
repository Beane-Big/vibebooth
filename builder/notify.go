package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

var notifyClient = &http.Client{Timeout: 5 * time.Second}

func notifyBuildResult(rec *Build, buildErr error) {
	if rec == nil || (buildErr == nil && rec.InstallAfter) {
		return
	}
	coreURL := strings.TrimRight(env("CORE_URL", "http://core:8080"), "/")
	title := fmt.Sprintf("应用构建成功：%s %s", rec.ModuleName, rec.Version)
	body := fmt.Sprintf("%s（%s）构建完成，可前往安装。", rec.ModuleName, rec.ModuleID)
	if buildErr != nil {
		title = fmt.Sprintf("应用构建失败：%s %s", rec.ModuleName, rec.Version)
		body = buildErr.Error()
	}
	payload, err := json.Marshal(map[string]any{
		"target":   map[string]any{"role": "admin"},
		"appId":    "builder",
		"title":    title,
		"body":     body,
		"link":     "/applications/build",
		"dedupKey": fmt.Sprintf("build-%d", rec.ID),
		"urgent":   true,
	})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, coreURL+"/api/platform/ext/v1/notifications", bytes.NewReader(payload))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := notifyClient.Do(req)
	if err == nil {
		resp.Body.Close()
	}
}
