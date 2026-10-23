module github.com/Beane-Big/vibebooth/packages/modpkg

go 1.26

replace github.com/Beane-Big/vibebooth/packages/manifest => ../manifest

require (
	github.com/Beane-Big/vibebooth/packages/manifest v0.1.0
	gopkg.in/yaml.v3 v3.0.1
)
