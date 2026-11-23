# Disposable stand-in for a brand-new Ubuntu machine right after someone set
# up SSH on it: an SSH server and a non-root account that can use sudo, and
# nothing else (no Git, curl, Python, Ansible, mise, Bun). One stage per
# accepted Ubuntu release, each pinned by index digest so it runs natively on
# amd64 and arm64 hosts; RELEASE chooses one (features/fresh-box/support/
# boxes.ts passes the release under test). Test tooling only; never a fleet
# node image.
ARG RELEASE=26.04
FROM ubuntu:26.04@sha256:d66b366dac61b575bee2aef07e9c26e8070096fbe84a3d4d3eb0da069b5d76db AS ubuntu-26.04
FROM ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b AS ubuntu-24.04
# hadolint ignore=DL3006
FROM ubuntu-${RELEASE}
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sudo openssh-server && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/sh fleettest \
  && printf 'fleettest ALL=(ALL) NOPASSWD:ALL\n' >/etc/sudoers.d/fleettest && chmod 0440 /etc/sudoers.d/fleettest \
  && mkdir -p /run/sshd \
  && echo 'ANSIBLE_LOG_PATH=/tmp/fleet-ansible.log' >>/etc/environment
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
