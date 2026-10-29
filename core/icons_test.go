package main

import (
	"strings"
	"testing"
)

func TestSplitIcon(t *testing.T) {
	cases := []struct {
		name, svg, color, glyph string
	}{
		{
			name:  "脚手架的图标：纯色底加白色图形",
			svg:   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#e8912d"/><path d="M24 11l3.9 7.9z" fill="#fff"/></svg>`,
			color: "#e8912d",
			glyph: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M24 11l3.9 7.9z" fill="#fff"/></svg>`,
		},
		{
			name:  "描边和填充同色，白色写法不同也算一种",
			svg:   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="#2f6fde"></rect><path d="M11 14h26z" fill="#FFFFFF"/><path d="M13 26v10" fill="none" stroke="white"/></svg>`,
			color: "#2f6fde",
			glyph: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M11 14h26z" fill="#FFFFFF"/><path d="M13 26v10" fill="none" stroke="white"/></svg>`,
		},
		{
			name:  "渐变底取第一个颜色，metadata 不算图形",
			svg:   `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><metadata><x>1</x></metadata><defs><linearGradient id="b"><stop stop-color="#3b82f6"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs><rect width="100%" height="100%" style="fill:url(#b)"/><g fill="#fff"><circle r="4"/></g></svg>`,
			color: "#3b82f6",
			glyph: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><metadata><x>1</x></metadata><defs><linearGradient id="b"><stop stop-color="#3b82f6"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs><g fill="#fff"><circle r="4"/></g></svg>`,
		},
		{
			name:  "占位的方块写成 none 或 currentColor，当成透明的底",
			svg:   `<svg viewBox="0 0 48 48"><rect width="48" height="48" fill="currentColor"/><circle r="9" fill="#fff"/></svg>`,
			color: "transparent",
			glyph: `<svg viewBox="0 0 48 48"><circle r="9" fill="#fff"/></svg>`,
		},
		{
			name:  "fill=none 同上",
			svg:   `<svg viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="none"/><path fill="#fff"/></svg>`,
			color: "transparent",
			glyph: `<svg viewBox="0 0 48 48"><path fill="#fff"/></svg>`,
		},
		{name: "图形有好几种颜色", svg: `<svg viewBox="0 0 64 64"><rect width="64" height="64" fill="#3b82f6"/><rect x="10" y="10" width="44" height="44" fill="#fffdf7"/><path stroke="#ef4444"/></svg>`},
		{name: "底色没铺满", svg: `<svg viewBox="0 0 48 48"><rect x="4" width="44" height="48" fill="#000"/><path fill="#fff"/></svg>`},
		{name: "第一个图形不是底色", svg: `<svg viewBox="0 0 48 48"><path fill="#fff"/><rect width="48" height="48" fill="#000"/></svg>`},
		{name: "图形用了渐变", svg: `<svg viewBox="0 0 48 48"><rect width="48" height="48" fill="#000"/><path fill="url(#g)"/></svg>`},
		{name: "有 style", svg: `<svg viewBox="0 0 48 48"><style>.a{fill:red}</style><rect width="48" height="48" fill="#000"/><path class="a"/></svg>`},
		{name: "不是 SVG", svg: "\x89PNG\r\n"},
	}
	for _, c := range cases {
		got := splitIcon([]byte(c.svg))
		if c.color == "" {
			if got != nil {
				t.Errorf("%s：不应拆开，拆成了 %q", c.name, got.color)
			}
			continue
		}
		if got == nil {
			t.Errorf("%s：应能拆开", c.name)
			continue
		}
		if got.color != c.color || string(got.glyph) != c.glyph {
			t.Errorf("%s：底色 %q，图形\n%s", c.name, got.color, got.glyph)
		}
	}
	if splitIcon([]byte(strings.Repeat(" ", maxSplitIcon+1))) != nil {
		t.Error("太大的图标不应拆")
	}
}
