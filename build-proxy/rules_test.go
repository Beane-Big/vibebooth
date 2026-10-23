package main

import (
	"net/http/httptest"
	"testing"
)

func TestAllow(t *testing.T) {
	cases := []struct {
		method, target string
		ok             bool
	}{
		{"GET", "/_ping", true},
		{"HEAD", "/v1.47/_ping", true},
		{"GET", "/v1.47/version", true},
		{"POST", "/v1.47/build?t=vb-notes-backend:0.2.0&version=2&buildargs=%7B%7D", true},
		{"POST", "/build?t=vb-notes-backend:0.2.0&t=vb-notes-frontend:0.2.0", true},
		{"POST", "/v1.47/build/prune", true},
		{"GET", "/v1.47/images/json", true},
		{"GET", "/v1.47/images/vb-notes-backend:0.2.0/json", true},
		{"GET", "/v1.47/images/get?names=vb-notes-backend:0.2.0&names=vb-notes-frontend:0.2.0", true},
		{"DELETE", "/v1.47/images/vb-notes-backend:0.1.0?force=1", true},

		{"POST", "/build", false},
		{"POST", "/build?t=traefik:v3.6", false},
		{"POST", "/build?t=vb-notes-backend:0.2.0&t=tecnativa/docker-socket-proxy:v0.4.1", false},
		{"POST", "/build?t=ghcr.io/vb-x:1", false},
		{"POST", "/build?t=vb-notes-backend:0.2.0&outputs=type%3Dimage%2Cname%3Dtraefik", false},
		{"POST", "/build?t=vb-notes-backend:0.2.0&networkmode=host", false},
		{"POST", "/build?t=vb-notes-backend:0.2.0&remote=https%3A%2F%2Fexample.com%2Fx.git", false},
		{"POST", "/v1.47/session", false},
		{"POST", "/grpc", false},
		{"GET", "/images/get", false},
		{"GET", "/images/get?names=postgres:17-alpine", false},
		{"GET", "/images/traefik:v3.6/json", false},
		{"DELETE", "/images/traefik:v3.6", false},
		{"DELETE", "/images/sha256:abc", false},
		{"POST", "/images/load", false},
		{"POST", "/images/vb-x:1/tag?repo=traefik", false},
		{"POST", "/images/vb-x:1/tag", false},
		{"POST", "/images/vb-x:1/tag?repo=vb-x&tag=1/../a", false},
		{"POST", "/v1.47/images/vb-notes-backend:0.2.0/tag?repo=vb-build-3-notes-backend&tag=0.2.0", true},
		{"POST", "/images/sha256:abc/tag?repo=vb-notes-backend&tag=0.2.0", false},
		{"POST", "/images/create?fromImage=traefik", false},
		{"POST", "/containers/create", false},
		{"GET", "/containers/json", false},
		{"POST", "/v1.47/volumes/create", false},
		{"POST", "/exec/abc/start", false},
	}
	for _, c := range cases {
		err := allow(httptest.NewRequest(c.method, c.target, nil))
		if (err == nil) != c.ok {
			t.Errorf("%s %s: 放行 = %v，应为 %v（%v）", c.method, c.target, err == nil, c.ok, err)
		}
	}
}
