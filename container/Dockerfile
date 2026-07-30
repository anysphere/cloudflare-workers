# Container image for one Cursor pool worker. Built by `wrangler deploy`.
#
# buildpack-deps:bookworm-scm already ships git, curl, ca-certificates,
# openssh-client and procps, so no apt-get layer is needed.
FROM buildpack-deps:bookworm-scm

RUN useradd --create-home --shell /bin/bash worker
USER worker
WORKDIR /home/worker

# Bake the cursor-agent CLI into the image so container boots don't pay the
# installer download. Redeploying the Worker rebuilds the image and picks up
# the latest CLI.
RUN curl -fsSL https://cursor.com/install | bash
ENV PATH="/home/worker/.local/bin:${PATH}"

COPY --chown=worker:worker --chmod=755 entrypoint.sh /home/worker/entrypoint.sh

ENTRYPOINT ["/home/worker/entrypoint.sh"]
