# RailForge Redis — self-hosted BullMQ backend.
#
# We deliberately use the official redis:7-alpine image rather than building
# from source. The only thing we add is our redis.conf and a tiny entrypoint
# that injects $REDIS_PASSWORD at start time (set as a Fly secret — never
# baked into the image).
FROM redis:7-alpine

COPY redis.conf /etc/redis/redis.conf

# --requirepass is appended at run time so the password lives only in the
# process argv of a private, internal-only VM. The image itself has no
# credentials.
ENTRYPOINT ["sh", "-c", "exec redis-server /etc/redis/redis.conf --requirepass \"$REDIS_PASSWORD\""]
