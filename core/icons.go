package main

import (
	"bytes"
	"encoding/xml"
	"io"
	"regexp"
	"strconv"
	"strings"
)

// iconLayers 是从模块的 icon.svg 拆出来的两层：底色和单色的图形。主题可以按自己的配色重新给两层上色（见 docs/theme-spec.md）。
type iconLayers struct {
	// 底色，铺满图标的那个 <rect> 的颜色；填的是渐变时取渐变的第一个颜色。
	color string
	// 去掉底色以后的 SVG。门户只用它的形状当蒙版，颜色由主题决定。
	glyph []byte
}

// 太大的图标不拆，也不会是脚手架画的那种简单图标。
const maxSplitIcon = 256 << 10

// 不画东西的元素，不算图形。
var nonGraphic = map[string]bool{"defs": true, "metadata": true, "title": true, "desc": true}

var plainColor = regexp.MustCompile(`^(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|[a-zA-Z]+)$`)

// splitIcon 把模块图标拆成底色和图形。只有脚手架模板的那种结构能拆：第一个图形元素是铺满整张图的 <rect>，
// 填纯色或渐变；其余的图形只用一种颜色（比如彩色圆角方块加白色图形）。图形里有好几种颜色、用了渐变、图片、文字或
// <style> 的图标拆了会丢掉细节，返回 nil，门户照原样显示。
func splitIcon(svg []byte) *iconLayers {
	if len(svg) > maxSplitIcon {
		return nil
	}
	d := xml.NewDecoder(bytes.NewReader(svg))
	var (
		width, height  float64
		depth          int
		inDefs         int // 在 <defs> 里时是 <defs> 的深度
		gradient       string
		stops          = map[string]string{} // 渐变 id → 第一个颜色
		bg             *iconLayers
		bgStart, bgEnd int64
		bgDepth        int
		colors         = map[string]bool{}
	)
	for {
		start := d.InputOffset()
		tok, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil
		}
		switch t := tok.(type) {
		case xml.StartElement:
			depth++
			name := t.Name.Local
			attr := attrs(t)
			switch {
			case depth == 1:
				if name != "svg" {
					return nil
				}
				width, height = viewSize(attr)
				if width <= 0 || height <= 0 {
					return nil
				}
			case name == "style" || name == "image" || name == "text" || name == "foreignObject":
				return nil
			case inDefs > 0:
				if name == "linearGradient" || name == "radialGradient" {
					gradient = attr["id"]
				} else if name == "stop" && gradient != "" && stops[gradient] == "" {
					stops[gradient] = paint(attr, "stop-color")
				}
			case name == "defs":
				inDefs = depth
			case depth == 2 && nonGraphic[name]:
				d.Skip()
				depth--
			case bg == nil:
				// 第一个图形元素必须是铺满的底色。
				if depth != 2 || name != "rect" || !fills(attr, width, height) {
					return nil
				}
				fill := paint(attr, "fill")
				if id, ok := strings.CutPrefix(fill, "url(#"); ok {
					fill = stops[strings.TrimSuffix(id, ")")]
				}
				// 写成 none、currentColor 的方块其实没有底色，只是占位，当成透明的底，主题下只显示图形。
				switch fill {
				case "none", "currentColor", "transparent":
					fill = "transparent"
				}
				if !plainColor.MatchString(fill) {
					return nil
				}
				bg = &iconLayers{color: fill}
				bgStart, bgDepth = start, depth
			default:
				for _, key := range []string{"fill", "stroke", "color"} {
					switch v := paint(attr, key); {
					case v == "" || v == "none" || v == "currentColor" || v == "inherit":
					case plainColor.MatchString(v):
						colors[normalColor(v)] = true
					default:
						return nil // 渐变或其他写法
					}
				}
				if len(colors) > 1 {
					return nil
				}
			}
		case xml.EndElement:
			if depth == bgDepth && bgEnd == 0 && bg != nil {
				bgEnd = d.InputOffset()
			}
			if depth == inDefs {
				inDefs = 0
			}
			gradient = ""
			depth--
		}
	}
	if bg == nil || bgEnd == 0 {
		return nil
	}
	bg.glyph = append(append([]byte{}, svg[:bgStart]...), svg[bgEnd:]...)
	return bg
}

func attrs(t xml.StartElement) map[string]string {
	m := map[string]string{}
	for _, a := range t.Attr {
		if a.Name.Space == "" {
			m[a.Name.Local] = strings.TrimSpace(a.Value)
		}
	}
	return m
}

// paint 读一个颜色属性，style 里写的优先，和浏览器一样。
func paint(attr map[string]string, key string) string {
	for _, decl := range strings.Split(attr["style"], ";") {
		if k, v, ok := strings.Cut(decl, ":"); ok && strings.TrimSpace(k) == key {
			return strings.TrimSpace(v)
		}
	}
	return attr[key]
}

// viewSize 是图标的画布大小，取 viewBox，没有时取 width、height。
func viewSize(attr map[string]string) (float64, float64) {
	if f := strings.Fields(strings.ReplaceAll(attr["viewBox"], ",", " ")); len(f) == 4 {
		if f[0] != "0" || f[1] != "0" {
			return 0, 0
		}
		return number(f[2]), number(f[3])
	}
	return number(attr["width"]), number(attr["height"])
}

// fills 判断 <rect> 是否铺满画布。
func fills(attr map[string]string, width, height float64) bool {
	full := func(v string, size float64) bool { return v == "100%" || number(v) == size }
	zero := func(v string) bool { return v == "" || number(v) == 0 }
	return zero(attr["x"]) && zero(attr["y"]) && full(attr["width"], width) && full(attr["height"], height)
}

func number(s string) float64 {
	n, err := strconv.ParseFloat(strings.TrimSuffix(s, "px"), 64)
	if err != nil {
		return -1
	}
	return n
}

// normalColor 让 #fff、#FFFFFF 和 white 算成同一种颜色。
func normalColor(c string) string {
	c = strings.ToLower(c)
	switch c {
	case "white":
		return "#ffffff"
	case "black":
		return "#000000"
	}
	if len(c) == 4 && c[0] == '#' {
		return "#" + string([]byte{c[1], c[1], c[2], c[2], c[3], c[3]})
	}
	return c
}
