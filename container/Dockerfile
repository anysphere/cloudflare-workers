# Container image for one guest pool worker. Built by `wrangler deploy`.
#
# buildpack-deps:bookworm-scm already ships git, curl, ca-certificates,
# openssh-client and procps.
FROM buildpack-deps:bookworm-scm

RUN useradd --create-home --shell /bin/bash worker
USER worker
WORKDIR /home/worker

RUN curl -fsSL https://cursor.com/install | bash
ENV PATH="/home/worker/.local/bin:${PATH}"

COPY --chown=worker:worker --chmod=755 entrypoint.sh /home/worker/entrypoint.sh

ENTRYPOINT ["/home/worker/entrypoint.sh"]
