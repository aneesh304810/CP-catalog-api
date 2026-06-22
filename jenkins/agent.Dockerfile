# =====================================================================
# CP Catalog - Jenkins build agent (air-gapped)
# Pre-provisions every tool the Jenkinsfile needs so build stages run
# without internet. Build this once, push to the internal registry, and
# reference it as a Kubernetes/OpenShift agent pod template in Jenkins.
#
# Tools: podman (rootless), oc, trivy, cosign, gitleaks, sqlplus (instant
# client), python3 + venv, node 20 + npm.
# =====================================================================
FROM registry.access.redhat.com/ubi9/ubi:latest

ARG OC_VERSION=4.15
ARG TRIVY_VERSION=0.55.0
ARG COSIGN_VERSION=2.4.0
ARG GITLEAKS_VERSION=8.18.4

USER 0

# --- base packages (from the internal RPM mirror in air-gapped setups) ---
RUN dnf install -y --nodocs \
        python3.11 python3.11-pip python3.11-devel \
        nodejs npm git make gcc unixODBC \
        podman fuse-overlayfs \
        libaio && \
    dnf clean all

# --- oc / kubectl ---
# In air-gapped: COPY the binaries from your internal artifact store instead
# of curling. Example assumes they are vendored under ./vendor/.
COPY vendor/oc /usr/local/bin/oc
COPY vendor/kubectl /usr/local/bin/kubectl
RUN chmod +x /usr/local/bin/oc /usr/local/bin/kubectl

# --- trivy, cosign, gitleaks (vendored binaries) ---
COPY vendor/trivy /usr/local/bin/trivy
COPY vendor/cosign /usr/local/bin/cosign
COPY vendor/gitleaks /usr/local/bin/gitleaks
RUN chmod +x /usr/local/bin/trivy /usr/local/bin/cosign /usr/local/bin/gitleaks

# --- Oracle Instant Client (for sqlplus migrations) ---
# Vendor the RPMs under ./vendor/oracle/ in air-gapped environments.
COPY vendor/oracle/ /tmp/oracle/
RUN dnf install -y /tmp/oracle/*.rpm && rm -rf /tmp/oracle && dnf clean all
ENV PATH="/usr/lib/oracle/21/client64/bin:${PATH}"
ENV LD_LIBRARY_PATH="/usr/lib/oracle/21/client64/lib"

# --- rootless podman config ---
RUN mkdir -p /etc/containers && \
    echo '[storage]' > /etc/containers/storage.conf && \
    echo 'driver = "overlay"' >> /etc/containers/storage.conf

# Jenkins agent runs as non-root
RUN useradd -u 1001 -m jenkins
USER 1001
WORKDIR /home/jenkins

# trivy offline DB: mount or COPY a pre-downloaded vuln DB at
# /home/jenkins/.cache/trivy in air-gapped clusters and set TRIVY_OFFLINE.
ENV TRIVY_CACHE_DIR=/home/jenkins/.cache/trivy

CMD ["sleep", "infinity"]
