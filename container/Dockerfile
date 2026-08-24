# Container image for the controller and for one guest pool worker.
# Built by `wrangler deploy`.
#
# buildpack-deps:bookworm-scm already ships git, curl, ca-certificates,
# openssh-client and procps. python3 is added for spawn.sh JSON encoding.
FROM buildpack-deps:bookworm-scm

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash worker
USER worker
WORKDIR /home/worker

# Pin a lab CLI when cursor-agent-version is set; otherwise prod install.
# Prod `cursor.com/install` currently ships without `worker controller`.
COPY --chown=worker:worker cursor-agent-version /tmp/cursor-agent-version
ARG TARGETARCH=amd64
ARG CURSOR_AGENT_VERSION=
RUN VERSION="$(sed -e 's/#.*//' -e 's/[[:space:]]//g' /tmp/cursor-agent-version | sed -e '/^$/d' | head -n 1)" && \
    VERSION="${VERSION:-${CURSOR_AGENT_VERSION:-}}" && \
    ARCH="$( [ "${TARGETARCH}" = "arm64" ] && echo arm64 || echo x64 )" && \
    mkdir -p "${HOME}/.local/share/cursor-agent/versions" "${HOME}/.local/bin" && \
    if [ -n "${VERSION}" ]; then \
      echo "installing cursor-agent lab ${VERSION} linux/${ARCH}" && \
      mkdir -p "${HOME}/.local/share/cursor-agent/versions/${VERSION}" && \
      curl -fsSL "https://downloads.cursor.com/lab/${VERSION}/linux/${ARCH}/agent-cli-package.tar.gz" \
        | tar --strip-components=1 -xzf - -C "${HOME}/.local/share/cursor-agent/versions/${VERSION}" && \
      ln -sf "${HOME}/.local/share/cursor-agent/versions/${VERSION}/cursor-agent" "${HOME}/.local/bin/agent" && \
      ln -sf "${HOME}/.local/share/cursor-agent/versions/${VERSION}/cursor-agent" "${HOME}/.local/bin/cursor-agent"; \
    else \
      echo "installing cursor-agent prod (no worker controller on current prod)" && \
      curl -fsSL https://cursor.com/install | bash; \
    fi && \
    rm -f /tmp/cursor-agent-version
ENV PATH="/home/worker/.local/bin:${PATH}"

COPY --chown=worker:worker --chmod=755 entrypoint.sh /home/worker/entrypoint.sh
COPY --chown=worker:worker --chmod=755 spawn.sh /home/worker/spawn.sh

ENTRYPOINT ["/home/worker/entrypoint.sh"]
