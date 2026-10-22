module github.com/Beane-Big/vibebooth/modules/hello/backend

go 1.26

require github.com/Beane-Big/vibebooth/packages/sdk-go v0.0.0

require github.com/golang-jwt/jwt/v5 v5.3.1 // indirect

replace github.com/Beane-Big/vibebooth/packages/sdk-go => ../../../packages/sdk-go
