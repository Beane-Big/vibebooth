module github.com/Beane-Big/home-platform/installer

go 1.26.0

replace (
	github.com/Beane-Big/home-platform/packages/manifest => ../packages/manifest
	github.com/Beane-Big/home-platform/packages/sdk-go => ../packages/sdk-go
)

require (
	github.com/Beane-Big/home-platform/packages/manifest v0.0.0
	github.com/Beane-Big/home-platform/packages/sdk-go v0.0.0
	gopkg.in/yaml.v3 v3.0.1
)

require github.com/golang-jwt/jwt/v5 v5.3.1 // indirect
