FROM alpine:3.20

RUN apk add --no-cache nginx nginx-mod-rtmp

EXPOSE 1935 8081

CMD ["nginx", "-g", "daemon off;"]
