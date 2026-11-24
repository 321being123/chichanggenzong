FROM alpine:3.23
RUN apk add --no-cache coreutils openssh-client tzdata util-linux \
    && addgroup -g 1000 backup \
    && adduser -D -u 1000 -G backup backup \
    && printf '0 3 * * 1 /usr/local/bin/portfolio-nas-pull\n' > /etc/crontabs/backup
COPY pull.sh /usr/local/bin/portfolio-nas-pull
RUN chmod 0755 /usr/local/bin/portfolio-nas-pull
ENV TZ=Asia/Shanghai
CMD ["crond", "-f", "-c", "/etc/crontabs", "-l", "5", "-L", "/dev/stdout"]
