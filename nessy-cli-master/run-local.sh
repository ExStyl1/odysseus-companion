docker run --rm -it \
  -v $(pwd)/docs-ru/:/auto-doc/docs \
  -v $(pwd)/auto-doc.json:/auto-doc/auto-doc.json \
  -p 3001:3000 \
  docker-hosted.artifactory.tcsbank.ru/unic/auto-docs-2:latest \
  sh -c "exec npm run start"
