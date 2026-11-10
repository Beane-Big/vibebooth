package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func wallpaperMux(s *Server) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/platform/wallpapers", func(w http.ResponseWriter, r *http.Request) { s.handleWallpapers(w, r, nil) })
	mux.HandleFunc("GET /api/platform/wallpapers/{id}/{size}", func(w http.ResponseWriter, r *http.Request) { s.handleWallpaperFile(w, r, nil) })
	mux.HandleFunc("POST /api/platform/wallpapers", func(w http.ResponseWriter, r *http.Request) { s.handleUploadWallpaper(w, r, nil) })
	return mux
}

func pngOf(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 128, 255})
		}
	}
	var buf bytes.Buffer
	png.Encode(&buf, img)
	return buf.Bytes()
}

func upload(t *testing.T, mux *http.ServeMux, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("image", "a.png")
	fw.Write(data)
	mw.Close()
	req := httptest.NewRequest("POST", "/api/platform/wallpapers", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func jpegSize(t *testing.T, path string) image.Point {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	cfg, err := jpeg.DecodeConfig(f)
	if err != nil {
		t.Fatal(err)
	}
	return image.Pt(cfg.Width, cfg.Height)
}

func TestUploadWallpaper(t *testing.T) {
	s := &Server{cfg: config{DataDir: t.TempDir()}}
	mux := wallpaperMux(s)

	rec := upload(t, mux, pngOf(3000, 1500))
	if rec.Code != 200 {
		t.Fatalf("上传返回 %d：%s", rec.Code, rec.Body)
	}
	var wp wallpaper
	json.Unmarshal(rec.Body.Bytes(), &wp)
	if !wallpaperIDPattern.MatchString(wp.ID) || !s.wallpaperExists(wp.ID) {
		t.Fatalf("上传后的 id %q 不能用", wp.ID)
	}
	if got := jpegSize(t, filepath.Join(s.wallpapersDir(), wp.ID+".jpg")); got != image.Pt(2560, 1280) {
		t.Errorf("大图应缩到 2560×1280，实际 %v", got)
	}
	if got := jpegSize(t, filepath.Join(s.wallpapersDir(), wp.ID+".thumb.jpg")); got != image.Pt(480, 240) {
		t.Errorf("缩略图应是 480×240，实际 %v", got)
	}

	if rec := upload(t, mux, []byte("not an image")); rec.Code != 400 {
		t.Errorf("不是图片应返回 400，实际 %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("GET", "/api/platform/wallpapers", nil))
	var list []wallpaper
	json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 2 || list[0].ID != bingID || list[1].ID != wp.ID {
		t.Errorf("列表应是必应加上传的那张，实际 %v", list)
	}

	for url, want := range map[string]int{
		"/api/platform/wallpapers/" + wp.ID + "/image": 200,
		"/api/platform/wallpapers/" + wp.ID + "/thumb": 200,
		"/api/platform/wallpapers/" + wp.ID + "/other": 404,
		"/api/platform/wallpapers/..%2fjwt.pem/image":  404,
		"/api/platform/wallpapers/000000000000/image":  404,
	} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", url, nil))
		if rec.Code != want {
			t.Errorf("%s 返回 %d，应为 %d", url, rec.Code, want)
		}
	}
}

// exifJPEG 做一张带 EXIF 方向的 JPEG：在 SOI 后面插一个 APP1 段。
func exifJPEG(w, h, orientation int) []byte {
	var buf bytes.Buffer
	jpeg.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h)), nil)
	tiff := []byte{'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, byte(orientation), 0, 0, 0, 0, 0, 0, 0, 0}
	seg := append([]byte("Exif\x00\x00"), tiff...)
	app1 := []byte{0xFF, 0xE1, byte((len(seg) + 2) >> 8), byte(len(seg) + 2)}
	data := buf.Bytes()
	return append(append(append([]byte{}, data[:2]...), append(app1, seg...)...), data[2:]...)
}

func TestWallpaperOrientation(t *testing.T) {
	for o, want := range map[int]image.Point{1: image.Pt(40, 20), 3: image.Pt(40, 20), 6: image.Pt(20, 40), 8: image.Pt(20, 40)} {
		data := exifJPEG(40, 20, o)
		if got := jpegOrientation(data); got != o {
			t.Errorf("方向应读出 %d，实际 %d", o, got)
		}
		img, err := decodeWallpaper(data)
		if err != nil {
			t.Fatal(err)
		}
		if got := img.Bounds().Size(); got != want {
			t.Errorf("方向 %d 转正后应是 %v，实际 %v", o, want, got)
		}
	}
	if got := jpegOrientation(pngOf(4, 4)); got != 1 {
		t.Errorf("PNG 没有方向，应是 1，实际 %d", got)
	}
}

func TestBingWallpaper(t *testing.T) {
	var image1 = pngOf(3840, 2160)
	urlPath := "/th?id=OHR.A_1920x1080.jpg"
	hits := 0
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/HPImageArchive.aspx":
			hits++
			json.NewEncoder(w).Encode(map[string]any{"images": []map[string]string{{
				"url": urlPath, "urlbase": "/th?id=OHR.A", "title": "山", "copyright": "© 某人",
			}}})
		case "/th":
			if r.URL.RawQuery == "id=OHR.A_UHD.jpg" {
				w.Write(image1)
				return
			}
			http.NotFound(w, r)
		}
	}))
	defer fake.Close()
	old := bingAPI
	bingAPI = fake.URL
	defer func() { bingAPI = old }()

	s := &Server{cfg: config{DataDir: t.TempDir()}}
	mux := wallpaperMux(s)
	get := func(url string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", url, nil))
		return rec
	}
	if rec := get("/api/platform/wallpapers/bing/image"); rec.Code != 200 {
		t.Fatalf("必应壁纸返回 %d：%s", rec.Code, rec.Body)
	}
	if got := jpegSize(t, filepath.Join(s.wallpapersDir(), "bing.jpg")); got != image.Pt(2560, 1440) {
		t.Errorf("必应 4K 图应缩到 2560×1440，实际 %v", got)
	}
	get("/api/platform/wallpapers/bing/thumb")
	if hits != 1 {
		t.Errorf("6 小时内不该再问必应，实际问了 %d 次", hits)
	}
	var list []wallpaper
	json.Unmarshal(get("/api/platform/wallpapers").Body.Bytes(), &list)
	if len(list) != 1 || list[0].Copyright != "山 © 某人" {
		t.Errorf("列表里必应壁纸应带标题和版权，实际 %v", list)
	}

	// 过期后再问一次；图没换就不重新下载，只更新检查时间。
	meta := filepath.Join(s.wallpapersDir(), "bing.json")
	past := time.Now().Add(-7 * time.Hour)
	os.Chtimes(meta, past, past)
	get("/api/platform/wallpapers/bing/image")
	if st, _ := os.Stat(meta); hits != 2 || time.Since(st.ModTime()) > time.Minute {
		t.Errorf("过期后应重新检查并更新时间，问了 %d 次", hits)
	}

	// 必应连不上时继续用存着的图，一刻钟后再试。
	bingAPI = "http://127.0.0.1:1"
	os.Chtimes(meta, past, past)
	if rec := get("/api/platform/wallpapers/bing/image"); rec.Code != 200 {
		t.Errorf("取不到新图时应继续用存着的，实际 %d", rec.Code)
	}
	if st, _ := os.Stat(meta); time.Until(st.ModTime().Add(bingRefresh)) > 16*time.Minute {
		t.Errorf("失败后应一刻钟左右再试")
	}
}

func TestWallpaperRotateLarge(t *testing.T) {
	// 竖着拍、记成横图加方向 6 的照片：转正后是 3000×4000，宽缩到 2560。
	img, err := decodeWallpaper(exifJPEG(4000, 3000, 6))
	if err != nil {
		t.Fatal(err)
	}
	if got := img.Bounds().Size(); got != image.Pt(2560, 3413) {
		t.Errorf("应转正并缩到 2560×3413，实际 %v", got)
	}
	// 横着的大图转正后宽 6000，缩到 2560。
	img, err = decodeWallpaper(exifJPEG(3000, 6000, 8))
	if err != nil {
		t.Fatal(err)
	}
	if got := img.Bounds().Size(); got != image.Pt(2560, 1280) {
		t.Errorf("应缩到 2560×1280，实际 %v", got)
	}
}
