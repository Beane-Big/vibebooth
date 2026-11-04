package main

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// installRequest 生成安装表单，fields 按顺序写入；名字是 package 的写成文件。
func installRequest(t *testing.T, fields ...[2]string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for _, f := range fields {
		if f[0] == "package" {
			w, _ := mw.CreateFormFile("package", "demo.zip")
			w.Write([]byte(f[1]))
		} else {
			mw.WriteField(f[0], f[1])
		}
	}
	mw.Close()
	r := httptest.NewRequest(http.MethodPost, "/api/platform/installer/modules", &body)
	r.Header.Set("Content-Type", mw.FormDataContentType())
	return r
}

func receive(t *testing.T, r *http.Request) (string, bool, int, error) {
	t.Helper()
	path, allow, status, err := (&server{}).receivePackage(r)
	if path != "" {
		t.Cleanup(func() { os.Remove(path) })
	}
	return path, allow, status, err
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestReceiveUpload(t *testing.T) {
	// 门户先写文件再写 allowPrivileges，边收边存时后面的字段也要读到。
	path, allow, _, err := receive(t, installRequest(t, [2]string{"package", "zipdata"}, [2]string{"allowPrivileges", "true"}))
	if err != nil || !allow || readFile(t, path) != "zipdata" {
		t.Fatalf("path=%q allow=%v err=%v", path, allow, err)
	}
}

func TestReceiveURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/pkg" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte("from-builder"))
	}))
	defer srv.Close()

	path, allow, _, err := receive(t, installRequest(t, [2]string{"url", srv.URL + "/pkg"}))
	if err != nil || allow || readFile(t, path) != "from-builder" {
		t.Fatalf("path=%q allow=%v err=%v", path, allow, err)
	}
	if _, _, status, err := receive(t, installRequest(t, [2]string{"url", srv.URL + "/gone"})); status != 400 || !strings.Contains(err.Error(), "404") {
		t.Fatalf("下载失败时应返回 400 和原因，实际 %d %v", status, err)
	}
	if _, _, status, err := receive(t, installRequest(t, [2]string{"url", "file:///etc/passwd"})); status != 400 || err == nil {
		t.Fatalf("只能用 http(s) 地址，实际 %d %v", status, err)
	}
}

func TestReceiveNeedsExactlyOne(t *testing.T) {
	for name, r := range map[string]*http.Request{
		"都没有":  installRequest(t, [2]string{"allowPrivileges", "true"}),
		"两个都有": installRequest(t, [2]string{"package", "x"}, [2]string{"url", "http://example.invalid/p"}),
		"不是表单": httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{}")),
	} {
		if _, _, status, err := receive(t, r); status != 400 || err == nil {
			t.Errorf("%s：应返回 400，实际 %d %v", name, status, err)
		}
	}
}

func TestLimitedReader(t *testing.T) {
	path, err := saveTemp(&limitedReader{r: strings.NewReader("12345"), n: 5})
	os.Remove(path)
	if err != nil {
		t.Fatalf("正好到上限不应报错：%v", err)
	}
	path, err = saveTemp(&limitedReader{r: strings.NewReader("123456"), n: 5})
	os.Remove(path)
	if err != errTooLarge {
		t.Fatalf("超过上限应报 errTooLarge，实际 %v", err)
	}
}
