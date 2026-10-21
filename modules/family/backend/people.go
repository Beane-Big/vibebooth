package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// peopleClient 调用人员管理模块的对外接口 v1（契约见 modules/people/contracts/openapi.yaml）。
// 目前没有服务令牌，直接在内部网络里请求 people-backend。
type peopleClient struct {
	baseURL string
	http    *http.Client
}

type person struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Photo string `json:"photo"`
}

var errPersonNotFound = errors.New("人员不存在")

func newPeopleClient(baseURL string) *peopleClient {
	// 同步调用：人员模块不可用时尽快失败，由调用方降级。
	return &peopleClient{baseURL: baseURL, http: &http.Client{Timeout: 3 * time.Second}}
}

func (c *peopleClient) List(ctx context.Context) ([]person, error) {
	var list []person
	err := c.get(ctx, "/api/people/ext/v1/persons", &list)
	return list, err
}

func (c *peopleClient) Get(ctx context.Context, id int64) (*person, error) {
	var p person
	if err := c.get(ctx, "/api/people/ext/v1/persons/"+strconv.FormatInt(id, 10), &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (c *peopleClient) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return errPersonNotFound
	case resp.StatusCode != http.StatusOK:
		return fmt.Errorf("人员接口返回 %s", resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
