#!/bin/bash

function show_usage() {
 echo "Usage: 'docker run -it nuage/import <VSD_IP> [Organization] [samples/xyz.nuage]'"
 echo "Or: 'docker run -it nuage/import <VSD_IP>' to get a shell"
 echo "For Openstack import, add '-e OS_USERNAME=... -e OS_PASSWORD=... -e OS_AUTH_URL=... -e OS_TENANT_NAME=...'"
 echo "Available config files in samples folder:"
 echo "Command Only Mode:"
 echo "\$1: FQDN or VSD_IP"
 echo "\$2: ORG Name"
 echo "\$3: File for provision (*.nuage)"
 echo "CLI Mode:"
 echo "\$1: FQDN or VSD_IP"
 exit 0
}

function cli-mode() {
  echo "Launching VSD CLI shell with VSD_IP=$1 ( only works if you used -it in docker run command )"
  export VSD_IP=$1
  echo
  echo "----Check your Parameters and Env Variables----"
  echo -e "\tTemplate for provision: $3"
  echo -e "\tOSP Username: $OS_USERNAME"
  echo -e "\tOSP Pass: $OS_PASSWORD"
  echo -e "\tOSP Tenant: $OS_TENANT_NAME"
  echo -e "\tOSP Keystone Endpoint: $OS_AUTH_URL"
  echo -e "\tVSP Nuage Endpoint: $VSD_IP"
  echo -e "\tVSP Nuage User: $VSP_NUAGE_USER"
  echo -e "\tVSP Nuage Pass: $VSP_NUAGE_PASS"
  echo
  /bin/bash
}

function execution-mode() {
  echo "Invoking import script with VSD_IP=$1 Organization=$2 Config_file=$3"
  if [[ -f $3 ]] || [[ ! -z $OS_USERNAME ]] || [[ ! -z $OS_PASSWORD ]] || [[ ! -z $OS_AUTH_URL ]] || [[ ! -z $OS_TENANT_NAME ]]; then
    export VSD_IP=$1
    export ORG_NAME=$2
    export CONF_FILE=$3
    ./import.js $VSD_IP "$ORG_NAME" $CONF_FILE
  else
    echo
    echo "----Check your Parameters and Env Variables----"
    echo -e "\tTemplate for provision: $3"
    echo -e "\tOSP Username: $OS_USERNAME"
    echo -e "\tOSP Pass: $OS_PASSWORD"
    echo -e "\tOSP Tenant: $OS_TENANT_NAME"
    echo -e "\tOSP Keystone Endpoint: $OS_AUTH_URL"
    echo -e "\tVSP Nuage Endpoint: $VSD_IP"
    echo -e "\tVSP Nuage User: $VSP_NUAGE_USER"
    echo -e "\tVSP Nuage Pass: $VSP_NUAGE_PASS"
    echo
    exit -1
  fi
}

if [[ -z "$1" ]] || [[ $# == 0 ]]; then
  show_usage
fi

case "$#" in
  1) cli-mode $1
  ;;

  [2-4]) execution-mode $1 $2 $3
  ;;

  *) show_usage
  ;;
esac
exit $?
