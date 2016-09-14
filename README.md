# Nuage Docker Provisioner
[![](https://images.microbadger.com/badges/version/padajuan/nuage-docker-provisioner.svg)](http://microbadger.com/images/padajuan/nuage-docker-provisioner "Get your own version badge on microbadger.com")
[![](https://images.microbadger.com/badges/image/padajuan/nuage-docker-provisioner.svg)](http://microbadger.com/images/padajuan/nuage-docker-provisioner)

This repository create a container that have some samples to be provisioned on a Openstack-Nuage infrastructure.

## Requirements
This container are based on some env variables to be pre-setup:
- VSP_NUAGE_USER: This variable is the user to access to Nuage Architect (DEFAULT: 'csproot')
- VSP_NUAGE_PASS: This variable is the password to access to Nuage Architect (DEFAULT: 'csproot')
- OS_TENANT_NAME: Openstack Tenant Name
- OS_USERNAME: Openstack User Name
- OS_PASSWORD: Openstack User-Password
- OS_AUTH_URL: Openstack Keystone Endpoint

## How this works?
This repository are linked with [Dockerhub](https://hub.docker.com/r/padajuan/nuage-docker-provisioner/), to make this work, you could follow this two paths:

### Cli-Mode
To enter on cli-mode just execute the container like this:
```sh
docker run -it --env-file ./demorc_region nuage-docker-provisioner <VSD_VIP>
```

- Examples
  - Passing all env variables:
```sh
docker run -it -e "OS_USERNAME=admin" -e "OS_TENANT_NAME=admin" -e "OS_PASSWORD=admin" -e "OS_AUTH_URL=http://keystone.demo.corp:35357/v2.0/" -e "VSP_NUAGE_USER=csproot" -e "VSP_NUAGE_PASS=admin" nuage-docker-provisioner nuage.demo.corp
```
  - or using an env-file:
```sh
docker run -it --env-file ./demorc_region nuage-docker-provisioner nuage.demo.corp
```

### Execution-Mode
This mode will execute a command and will stop the container, is more suitable to be integrated with CI/CD stuff like jenkins.

To enter on execution-mode just execute the container like this:
```sh
docker run -it --env-file ./demorc_region nuage-docker-provisioner <VSD_VIP> <TENANT/DOMAIN> <sample/*.nuage file>
```

- Example
```sh
docker run -it --env-file ./demorc_region nuage-docker-provisioner 192.168.0.100 COMMS_TEST samples/3-tier-app.nuage
```

## Infrastructure Versions
- **Nuage:** 3.0R7 -> 3.2R8 (Not tested on the next ones).
- **Openstack:** Juno|Kilo|Liberty

## References
The original container [url](https://hub.docker.com/r/nuage/import/), but yeah, no documentation.
I cannot make a fork because there is not github repo, then this is the result.
