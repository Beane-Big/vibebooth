package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// 壁纸由平台保存，交给声明了使用平台壁纸的主题当页面背景（见 docs/theme-spec.md）。
// 有两种：管理员上传的图片，和必应每日壁纸。都存在 core-data 卷的 wallpapers/ 下，
// 每张存一份大图（最宽 2560px）和一份缩略图（宽 480px），都是 JPEG。
const (
	maxWallpaperUpload = 25 << 20
	// 解码前先看尺寸，像素太多的图（比如解压炸弹）直接拒绝。
	maxWallpaperPixels = 60_000_000
	wallpaperWidth     = 2560
	wallpaperThumb     = 480
	bingID             = "bing"
	// 必应每天换一张图；隔这么久再去取一次，取不到时继续用存着的。
	bingRefresh = 6 * time.Hour
)

var wallpaperIDPattern = regexp.MustCompile(`^[0-9a-f]{12}$`)

// bingAPI 是必应每日壁纸的接口，测试时换成本地的假服务器。
var bingAPI = "https://cn.bing.com"

type wallpaper struct {
	ID string `json:"id"`
	// 必应壁纸带标题和版权说明，上传的图片没有。
	Title     string `json:"title,omitempty"`
	Copyright string `json:"copyright,omitempty"`
}

func (s *Server) wallpapersDir() string { return filepath.Join(s.cfg.DataDir, "wallpapers") }

// wallpaperExists 判断一个壁纸 id 能不能用：必应每日壁纸总是能选，上传的要文件还在。
func (s *Server) wallpaperExists(id string) bool {
	if id == bingID {
		return true
	}
	if !wallpaperIDPattern.MatchString(id) {
		return false
	}
	_, err := os.Stat(filepath.Join(s.wallpapersDir(), id+".jpg"))
	return err == nil
}

// handleWallpapers 列出可以选的壁纸：必应每日壁纸在最前面，上传的按上传时间从新到旧。所有登录的人都能看。
func (s *Server) handleWallpapers(w http.ResponseWriter, _ *http.Request, _ *User) {
	list := []wallpaper{{ID: bingID, Title: "必应每日壁纸"}}
	if info, err := s.bingInfo(); err == nil {
		list[0].Copyright = info.Title + " " + info.Copyright
	}
	paths, _ := filepath.Glob(filepath.Join(s.wallpapersDir(), "*.thumb.jpg"))
	type item struct {
		id  string
		mod time.Time
	}
	var items []item
	for _, p := range paths {
		id := strings.TrimSuffix(filepath.Base(p), ".thumb.jpg")
		if !wallpaperIDPattern.MatchString(id) {
			continue
		}
		if st, err := os.Stat(p); err == nil {
			items = append(items, item{id, st.ModTime()})
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].mod.After(items[j].mod) })
	for _, it := range items {
		list = append(list, wallpaper{ID: it.id})
	}
	writeJSON(w, http.StatusOK, list)
}

// handleWallpaperFile 发一张壁纸的大图（image）或缩略图（thumb）。必应壁纸在这里按需更新。
func (s *Server) handleWallpaperFile(w http.ResponseWriter, r *http.Request, _ *User) {
	id, size := r.PathValue("id"), r.PathValue("size")
	if size != "image" && size != "thumb" {
		http.NotFound(w, r)
		return
	}
	name := id + ".jpg"
	if size == "thumb" {
		name = id + ".thumb.jpg"
	}
	switch {
	case id == bingID:
		if err := s.refreshBing(r.Context()); err != nil {
			slog.Warn("更新必应每日壁纸失败", "err", err)
		}
		// 必应的图每天换，浏览器缓存一会儿就重新问。
		w.Header().Set("Cache-Control", "private, max-age=3600")
	case wallpaperIDPattern.MatchString(id):
		// 上传的图片不会变，删了就是换了 id。
		w.Header().Set("Cache-Control", "private, max-age=604800, immutable")
	default:
		http.NotFound(w, r)
		return
	}
	file := filepath.Join(s.wallpapersDir(), name)
	if _, err := os.Stat(file); err != nil {
		writeError(w, http.StatusNotFound, "壁纸不存在或还没取到")
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, file)
}

// handleUploadWallpaper 上传一张壁纸，要有“应用管理”权限，和安装主题一样。支持 JPEG、PNG、WebP。
func (s *Server) handleUploadWallpaper(w http.ResponseWriter, r *http.Request, _ *User) {
	// 服务器默认 30 秒内要读完请求，25 MB 的照片在家里的上行网络上可能传不完，这个请求放宽到 5 分钟。
	rc := http.NewResponseController(w)
	rc.SetReadDeadline(time.Now().Add(5 * time.Minute))
	rc.SetWriteDeadline(time.Now().Add(6 * time.Minute))
	r.Body = http.MaxBytesReader(w, r.Body, maxWallpaperUpload+1<<20)
	file, _, err := r.FormFile("image")
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("没有收到图片，或图片超过 %d MB", maxWallpaperUpload>>20))
		return
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxWallpaperUpload+1))
	if err != nil || len(data) > maxWallpaperUpload {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("图片不能超过 %d MB", maxWallpaperUpload>>20))
		return
	}
	img, err := decodeWallpaper(data)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	buf := make([]byte, 6)
	rand.Read(buf)
	id := hex.EncodeToString(buf)
	if err := saveWallpaper(s.wallpapersDir(), id, img); err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, wallpaper{ID: id})
}

// handleDeleteWallpaper 删除一张上传的壁纸。它正好是平台默认壁纸时，默认改回不用壁纸。必应每日壁纸删不了。
func (s *Server) handleDeleteWallpaper(w http.ResponseWriter, r *http.Request, _ *User) {
	id := r.PathValue("id")
	if !wallpaperIDPattern.MatchString(id) || !s.wallpaperExists(id) {
		writeError(w, http.StatusNotFound, "没有这张壁纸")
		return
	}
	if def, err := s.store.Setting(r.Context(), defaultWallpaperKey); err == nil && def == id {
		if err := s.store.SetSetting(r.Context(), defaultWallpaperKey, ""); err != nil {
			internalError(w, err)
			return
		}
	}
	for _, name := range []string{id + ".jpg", id + ".thumb.jpg"} {
		if err := os.Remove(filepath.Join(s.wallpapersDir(), name)); err != nil && !os.IsNotExist(err) {
			internalError(w, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// decodeWallpaper 解码上传的图片，缩到最宽 wallpaperWidth，再按 JPEG 里记录的拍摄方向转正（手机照片常见），太大的图拒绝。
// 先缩小再转正：转正是逐个像素搬，在几千万像素的原图上做又慢又占内存。
func decodeWallpaper(data []byte) (image.Image, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("不是支持的图片格式，请上传 JPEG、PNG 或 WebP")
	}
	if cfg.Width*cfg.Height > maxWallpaperPixels {
		return nil, fmt.Errorf("图片太大（%d×%d），请缩小后再上传", cfg.Width, cfg.Height)
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("图片解码失败，文件可能损坏了")
	}
	o := jpegOrientation(data)
	b := img.Bounds()
	// 转正后的宽度：方向 5～8 是转了 90 度的，原图的高才是转正后的宽。
	w, h := b.Dx(), b.Dy()
	if o >= 5 {
		w, h = h, w
	}
	if w > wallpaperWidth {
		nh := max(1, h*wallpaperWidth/w)
		sw, sh := wallpaperWidth, nh
		if o >= 5 {
			sw, sh = nh, wallpaperWidth
		}
		dst := image.NewRGBA(image.Rect(0, 0, sw, sh))
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
		img = dst
	}
	return orient(img, o), nil
}

// saveWallpaper 把图片存成大图和缩略图。先写临时文件再改名，列表里不会出现写了一半的图。
func saveWallpaper(dir, id string, img image.Image) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, out := range []struct {
		name  string
		width int
	}{{id + ".jpg", wallpaperWidth}, {id + ".thumb.jpg", wallpaperThumb}} {
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, scaleToWidth(img, out.width), &jpeg.Options{Quality: 85}); err != nil {
			return err
		}
		tmp := filepath.Join(dir, ".tmp-"+out.name)
		if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, filepath.Join(dir, out.name)); err != nil {
			return err
		}
	}
	return nil
}

// scaleToWidth 把比 width 宽的图等比缩小到 width，窄的不放大。
func scaleToWidth(img image.Image, width int) image.Image {
	b := img.Bounds()
	if b.Dx() <= width {
		return img
	}
	height := max(1, b.Dy()*width/b.Dx())
	dst := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Src, nil)
	return dst
}

// ---- 必应每日壁纸 ----

type bingMeta struct {
	Title     string `json:"title"`
	Copyright string `json:"copyright"`
	URL       string `json:"url"`
}

var bingMu sync.Mutex

func (s *Server) bingInfo() (bingMeta, error) {
	var m bingMeta
	data, err := os.ReadFile(filepath.Join(s.wallpapersDir(), "bing.json"))
	if err == nil {
		err = json.Unmarshal(data, &m)
	}
	return m, err
}

// refreshBing 在存着的必应壁纸超过 bingRefresh 没更新时去取今天的图。只有有人用到它时才会去取；
// 同一时间只取一次，取失败时下次请求再试，期间继续用存着的那张。
func (s *Server) refreshBing(ctx context.Context) error {
	bingMu.Lock()
	defer bingMu.Unlock()
	metaFile := filepath.Join(s.wallpapersDir(), "bing.json")
	if st, err := os.Stat(metaFile); err == nil && time.Since(st.ModTime()) < bingRefresh {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var resp struct {
		Images []struct {
			URL       string `json:"url"`
			URLBase   string `json:"urlbase"`
			Title     string `json:"title"`
			Copyright string `json:"copyright"`
		} `json:"images"`
	}
	body, err := httpGet(ctx, bingAPI+"/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN", 1<<20)
	if err != nil {
		return s.touchBing(err)
	}
	if err := json.Unmarshal(body, &resp); err != nil || len(resp.Images) == 0 || !strings.HasPrefix(resp.Images[0].URL, "/") {
		return s.touchBing(fmt.Errorf("必应返回的内容看不懂: %v", err))
	}
	im := resp.Images[0]
	meta := bingMeta{Title: im.Title, Copyright: im.Copyright, URL: im.URL}
	// 同一张图不用重新下载，只记一下这次检查过了。
	if old, err := s.bingInfo(); err == nil && old.URL == meta.URL {
		return s.touchBing(nil)
	}
	// 优先取 4K 原图再缩到 2560px，比直接用 1920px 的清楚；取不到就用接口给的那张。
	var data []byte
	if im.URLBase != "" && strings.HasPrefix(im.URLBase, "/") {
		data, err = httpGet(ctx, bingAPI+im.URLBase+"_UHD.jpg", maxWallpaperUpload)
	}
	if data == nil {
		if data, err = httpGet(ctx, bingAPI+im.URL, maxWallpaperUpload); err != nil {
			return s.touchBing(err)
		}
	}
	img, err := decodeWallpaper(data)
	if err != nil {
		return s.touchBing(err)
	}
	if err := saveWallpaper(s.wallpapersDir(), bingID, img); err != nil {
		return err
	}
	out, _ := json.Marshal(meta)
	return os.WriteFile(metaFile, out, 0o644)
}

// touchBing 更新检查时间：取失败时也要隔一会儿再试，免得每个请求都去连必应、拖慢页面。
// 还没有存过必应壁纸时不记，下次请求接着试。
func (s *Server) touchBing(cause error) error {
	metaFile := filepath.Join(s.wallpapersDir(), "bing.json")
	if _, err := os.Stat(metaFile); err == nil {
		now := time.Now()
		if cause != nil {
			// 失败时过一刻钟再试，不用等满 bingRefresh。
			now = now.Add(15*time.Minute - bingRefresh)
		}
		os.Chtimes(metaFile, now, now)
	}
	return cause
}

func httpGet(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s 返回 %s", url, res.Status)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err == nil && int64(len(data)) > limit {
		err = fmt.Errorf("%s 内容太大", url)
	}
	return data, err
}

// ---- JPEG 拍摄方向 ----

// jpegOrientation 读出 JPEG 的 EXIF 方向（1～8），读不到时是 1（不用转）。
func jpegOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	for i := 2; i+4 <= len(data); {
		if data[i] != 0xFF {
			return 1
		}
		marker := data[i+1]
		size := int(binary.BigEndian.Uint16(data[i+2:]))
		if marker == 0xDA || size < 2 || i+2+size > len(data) {
			return 1
		}
		seg := data[i+4 : i+2+size]
		if marker == 0xE1 && len(seg) > 14 && string(seg[:6]) == "Exif\x00\x00" {
			return exifOrientation(seg[6:])
		}
		i += 2 + size
	}
	return 1
}

func exifOrientation(tiff []byte) int {
	var bo binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	off := int(bo.Uint32(tiff[4:]))
	if off+2 > len(tiff) {
		return 1
	}
	n := int(bo.Uint16(tiff[off:]))
	for k := 0; k < n; k++ {
		e := off + 2 + k*12
		if e+12 > len(tiff) {
			return 1
		}
		if bo.Uint16(tiff[e:]) == 0x0112 {
			if v := int(bo.Uint16(tiff[e+8:])); v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}

// orient 按 EXIF 方向把图转正。
func orient(img image.Image, o int) image.Image {
	if o <= 1 || o > 8 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch o {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			dst.Set(dx, dy, img.At(b.Min.X+x, b.Min.Y+y))
		}
	}
	return dst
}
