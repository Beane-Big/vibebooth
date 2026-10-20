module github.com/Beane-Big/home-platform/modules/hello/backend

go 1.26

require github.com/Beane-Big/home-platform/packages/sdk-go v0.0.0

require github.com/golang-jwt/jwt/v5 v5.3.1 // indirect

replace github.com/Beane-Big/home-platform/packages/sdk-go => ../../../packages/sdk-go
