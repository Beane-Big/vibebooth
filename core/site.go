package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"image"
	"image/png"
	_ "image/jpeg"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	defaultSiteName      = "Vibebooth"
	siteNameKey          = "site_name"
	siteICPKey           = "site_icp"
	sitePoliceKey        = "site_police"
	siteAllowRegisterKey = "site_allow_registration"
	siteTermsKey         = "site_terms_url"
	sitePrivacyKey       = "site_privacy_url"
	siteLogoExtKey       = "site_logo_ext"
	siteLogoVerKey       = "site_logo_ver"

	maxSiteLogoUpload = 5 << 20
	maxSiteLogoPixels = 16_000_000
	maxSiteLogoDim    = 512
)

// site 是站点的公开配置，登录页、访客首页和门户顶栏都会读取。
// 优先使用管理员在后台保存的设置，未保存过时回落到 .env 中的初始值。
type site struct {
	Name              string `json:"name"`
	HasLogo           bool   `json:"hasLogo"`
	LogoURL           string `json:"logoUrl"`
	ICP               string `json:"icp"`
	Police            string `json:"police"`
	PoliceCode        string `json:"policeCode"`
	AllowRegistration bool   `json:"allowRegistration"`
	Terms             string `json:"terms"`
	Privacy           string `json:"privacy"`
}

func (s *Server) siteDir() string { return filepath.Join(s.cfg.DataDir, "site") }

func (s *Server) currentSite(ctx context.Context) (site, error) {
	out := site{
		Name:              defaultSiteName,
		ICP:               s.cfg.ICPBeian,
		Police:            s.cfg.PoliceBeian,
		AllowRegistration: true,
		Terms:             policyURL("AUTH_TERMS_URL"),
		Privacy:           policyURL("AUTH_PRIVACY_URL"),
	}
	if s.store != nil {
		vals, err := s.store.SettingsByKeys(ctx,
			siteNameKey, siteICPKey, sitePoliceKey, siteAllowRegisterKey,
			siteTermsKey, sitePrivacyKey, siteLogoExtKey, siteLogoVerKey,
		)
		if err != nil {
			return out, err
		}
		if v, ok := vals[siteNameKey]; ok && strings.TrimSpace(v) != "" {
			out.Name = strings.TrimSpace(v)
		}
		if v, ok := vals[siteICPKey]; ok {
			out.ICP = v
		}
		if v, ok := vals[sitePoliceKey]; ok {
			out.Police = v
		}
		if v, ok := vals[siteAllowRegisterKey]; ok {
			out.AllowRegistration = v != "false"
		}
		if v, ok := vals[siteTermsKey]; ok {
			out.Terms = v
		}
		if v, ok := vals[sitePrivacyKey]; ok {
			out.Privacy = v
		}
		if ext := vals[siteLogoExtKey]; ext == "png" || ext == "svg" {
			if s.cfg.DataDir != "" {
				if _, err := os.Stat(filepath.Join(s.siteDir(), "logo."+ext)); err == nil {
					out.HasLogo = true
					ver := vals[siteLogoVerKey]
					if ver != "" {
						out.LogoURL = "/api/platform/site/logo?v=" + ver
					} else {
						out.LogoURL = "/api/platform/site/logo"
					}
				}
			}
		}
	}
	out.PoliceCode = digits(out.Police)
	return out, nil
}

func (s *Server) handleSite(w http.ResponseWriter, r *http.Request) {
	info, err := s.currentSite(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleUpdateSite(w http.ResponseWriter, r *http.Request, _ *User) {
	var in struct {
		Name              *string `json:"name"`
		ICP               *string `json:"icp"`
		Police            *string `json:"police"`
		AllowRegistration *bool   `json:"allowRegistration"`
		Terms             *string `json:"terms"`
		Privacy           *string `json:"privacy"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if name == "" {
			name = defaultSiteName
		}
		if utf8.RuneCountInString(name) > 40 {
			writeError(w, http.StatusBadRequest, "产品名称不能超过 40 个字符")
			return
		}
		if err := s.store.SetSetting(r.Context(), siteNameKey, name); err != nil {
			internalError(w, err)
			return
		}
	}
	if in.ICP != nil {
		v := strings.TrimSpace(*in.ICP)
		if utf8.RuneCountInString(v) > 80 {
			writeError(w, http.StatusBadRequest, "ICP 备案号过长")
			return
		}
		if err := s.store.SetSetting(r.Context(), siteICPKey, v); err != nil {
			internalError(w, err)
			return
		}
	}
	if in.Police != nil {
		v := strings.TrimSpace(*in.Police)
		if utf8.RuneCountInString(v) > 80 {
			writeError(w, http.StatusBadRequest, "公安备案号过长")
			return
		}
		if err := s.store.SetSetting(r.Context(), sitePoliceKey, v); err != nil {
			internalError(w, err)
			return
		}
	}
	if in.AllowRegistration != nil {
		v := "true"
		if !*in.AllowRegistration {
			v = "false"
		}
		if err := s.store.SetSetting(r.Context(), siteAllowRegisterKey, v); err != nil {
			internalError(w, err)
			return
		}
	}
	if in.Terms != nil {
		v, ok := validateHTTPSOrEmpty(*in.Terms)
		if !ok {
			writeError(w, http.StatusBadRequest, "服务条款链接必须以 https:// 开头")
			return
		}
		if err := s.store.SetSetting(r.Context(), siteTermsKey, v); err != nil {
			internalError(w, err)
			return
		}
	}
	if in.Privacy != nil {
		v, ok := validateHTTPSOrEmpty(*in.Privacy)
		if !ok {
			writeError(w, http.StatusBadRequest, "隐私声明链接必须以 https:// 开头")
			return
		}
		if err := s.store.SetSetting(r.Context(), sitePrivacyKey, v); err != nil {
			internalError(w, err)
			return
		}
	}
	info, err := s.currentSite(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleSiteLogo(w http.ResponseWriter, r *http.Request) {
	ext, err := s.store.Setting(r.Context(), siteLogoExtKey)
	if err != nil {
		internalError(w, err)
		return
	}
	if ext != "png" && ext != "svg" {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(s.siteDir(), "logo."+ext)
	data, err := os.ReadFile(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	if ext == "svg" {
		w.Header().Set("Content-Type", "image/svg+xml")
		w.Header().Set("Content-Security-Policy", "sandbox")
	} else {
		w.Header().Set("Content-Type", "image/png")
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(data)
}

var unsafeSVGPattern = regexp.MustCompile(`(?i)<\s*script|on[a-z]+\s*=|javascript:|<\s*foreignObject`)

func (s *Server) handleUploadSiteLogo(w http.ResponseWriter, r *http.Request, _ *User) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSiteLogoUpload+1<<20)
	file, _, err := r.FormFile("logo")
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeError(w, http.StatusRequestEntityTooLarge, "Logo 不能超过 5 MB")
			return
		}
		writeError(w, http.StatusBadRequest, "请选择要上传的 Logo 图片")
		return
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maxSiteLogoUpload+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "读取图片失败")
		return
	}
	if len(raw) == 0 {
		writeError(w, http.StatusBadRequest, "图片内容为空")
		return
	}
	if len(raw) > maxSiteLogoUpload {
		writeError(w, http.StatusRequestEntityTooLarge, "Logo 不能超过 5 MB")
		return
	}

	var ext string
	var outBytes []byte
	trimmed := bytes.TrimSpace(raw)
	if looksLikeSVG(trimmed) {
		if unsafeSVGPattern.Match(trimmed) {
			writeError(w, http.StatusBadRequest, "SVG 不能包含脚本或事件属性")
			return
		}
		ext = "svg"
		outBytes = trimmed
	} else {
		encoded, err := encodeSiteLogoPNG(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		ext = "png"
		outBytes = encoded
	}

	if err := os.MkdirAll(s.siteDir(), 0o755); err != nil {
		internalError(w, err)
		return
	}
	target := filepath.Join(s.siteDir(), "logo."+ext)
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, outBytes, 0o644); err != nil {
		internalError(w, err)
		return
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		internalError(w, err)
		return
	}
	other := "svg"
	if ext == "svg" {
		other = "png"
	}
	_ = os.Remove(filepath.Join(s.siteDir(), "logo."+other))

	verBytes := make([]byte, 6)
	_, _ = rand.Read(verBytes)
	ver := hex.EncodeToString(verBytes)
	if err := s.store.SetSetting(r.Context(), siteLogoExtKey, ext); err != nil {
		internalError(w, err)
		return
	}
	if err := s.store.SetSetting(r.Context(), siteLogoVerKey, ver); err != nil {
		internalError(w, err)
		return
	}
	info, err := s.currentSite(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (s *Server) handleDeleteSiteLogo(w http.ResponseWriter, r *http.Request, _ *User) {
	_ = os.Remove(filepath.Join(s.siteDir(), "logo.png"))
	_ = os.Remove(filepath.Join(s.siteDir(), "logo.svg"))
	if err := s.store.SetSetting(r.Context(), siteLogoExtKey, ""); err != nil {
		internalError(w, err)
		return
	}
	if err := s.store.SetSetting(r.Context(), siteLogoVerKey, ""); err != nil {
		internalError(w, err)
		return
	}
	info, err := s.currentSite(r.Context())
	if err != nil {
		internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func looksLikeSVG(data []byte) bool {
	s := strings.ToLower(string(data[:min(len(data), 512)]))
	return strings.Contains(s, "<svg") && (strings.HasPrefix(s, "<svg") || strings.HasPrefix(s, "<?xml"))
}

func encodeSiteLogoPNG(raw []byte) ([]byte, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return nil, errors.New("仅支持 PNG、JPEG、WebP 或 SVG 图片")
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxSiteLogoPixels {
		return nil, errors.New("图片尺寸超出限制")
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return nil, errors.New("图片解码失败")
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w > maxSiteLogoDim || h > maxSiteLogoDim {
		if w >= h {
			h = max(1, h*maxSiteLogoDim/w)
			w = maxSiteLogoDim
		} else {
			w = max(1, w*maxSiteLogoDim/h)
			h = maxSiteLogoDim
		}
		dst := image.NewNRGBA(image.Rect(0, 0, w, h))
		draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
		img = dst
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, errors.New("图片编码失败")
	}
	return buf.Bytes(), nil
}

func validateHTTPSOrEmpty(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", true
	}
	if len(value) > 512 {
		return "", false
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil {
		return "", false
	}
	return value, true
}

// digits 取出字符串里的数字。
func digits(v string) string {
	var b strings.Builder
	for _, r := range v {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
