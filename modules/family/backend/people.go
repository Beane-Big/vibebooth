package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

var (
	errPersonNotFound = errors.New("人员不存在")
	errInvalidPhoto   = errors.New("照片格式不对或太大")
)

func newPeopleClient(baseURL string) *peopleClient {
	// 同步调用：人员模块不可用时尽快失败，由调用方降级。
	return &peopleClient{baseURL: baseURL, http: &http.Client{Timeout: 3 * time.Second}}
}

func (c *peopleClient) List(ctx context.Context) ([]person, error) {
	var list []person
	err := c.do(ctx, http.MethodGet, "/api/people/ext/v1/persons", nil, &list)
	return list, err
}

func (c *peopleClient) Get(ctx context.Context, id int64) (*person, error) {
	var p person
	if err := c.do(ctx, http.MethodGet, "/api/people/ext/v1/persons/"+strconv.FormatInt(id, 10), nil, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// SetPhoto 替人员换头像；照片归人员管理模块保存，这里不留副本。
func (c *peopleClient) SetPhoto(ctx context.Context, id int64, photo string) (*person, error) {
	var p person
	path := "/api/people/ext/v1/persons/" + strconv.FormatInt(id, 10) + "/photo"
	if err := c.do(ctx, http.MethodPut, path, map[string]string{"photo": photo}, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (c *peopleClient) do(ctx context.Context, method, path string, body, out any) error {
	var reader io.Reader // 保持为 nil 接口：没有请求体时不能传一个空指针进去
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound:
		return errPersonNotFound
	case resp.StatusCode == http.StatusBadRequest:
		// 人员模块只有换照片接口会因为内容不合法返回 400。
		return errInvalidPhoto
	case resp.StatusCode != http.StatusOK:
		return fmt.Errorf("人员接口返回 %s", resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
