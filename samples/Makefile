SCRIPT ?= "3-tier-app.nuage"

ORG ?= "Test Org"

VSD ?= "138.120.70.233"

OS ?= "135.121.109.123"

.PHONY: all 

all: network

network:
	docker run -i --rm nuage/import:1.0 ${VSD} "${ORG}" < ${SCRIPT}

os-network:
	docker run -i --rm -e OS_USERNAME=admin -e OS_PASSWORD=admin -e OS_AUTH_URL=http://osc-kilo.nuage.local:35357/v2.0 -e OS_TENANT_NAME="demo" --add-host=osc-kilo.nuage.local:${OS} nuage/import:1.0 \
	${VSD} "${ORG}" < ${SCRIPT}

