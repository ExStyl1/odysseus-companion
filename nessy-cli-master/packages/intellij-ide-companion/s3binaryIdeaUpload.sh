#!/bin/bash

helpFunction()
{
   echo ""
   echo "Usage: $0 -a access_key -k secret_key"
   echo -e "\t-a Description of what is access_key"
   echo -e "\t-s Description of what is secret_key"
   exit 1
}

upload_to_s3() {
    local access_key=$1
    local secret_key=$2
    local idea_archive=$3

    echo "Uploading ${idea_archive} to S3..."

    s3cmd --verbose \
          --host=s3-msk.tinkoff.ru \
          --host-bucket=nestor-companion.s3-msk.tinkoff.ru \
          --access_key=$access_key \
          --secret_key=$secret_key \
          put "./binary/${idea_archive}" "s3://nestor-companion/intellij-idea-releases/${idea_archive}"

    echo "Upload completed"
}

while getopts "a:s:" opt
do
   case "$opt" in
      a ) access_key="$OPTARG" ;;
      s ) secret_key="$OPTARG" ;;
      ? ) helpFunction ;;
   esac
done

if [ -z "$access_key" ] || [ -z "$secret_key" ]
then
   echo "Some or all of the parameters are empty";
   helpFunction
fi

# Пример использования
IDEA_ARCHIVE="ideaIC-2023.3.tar.gz"
upload_to_s3 "$access_key" "$secret_key" "$IDEA_ARCHIVE"
