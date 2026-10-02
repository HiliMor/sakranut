#!/usr/bin/env bash
# Install a locally built release without touching the existing news checkout.
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 || $# -ne 2 ]]; then
  echo "Usage (root): install.sh /absolute/bundle-directory release-id" >&2
  exit 1
fi
bundle_dir="$1"
release_id="$2"
if [[ "${bundle_dir}" != /* || "${bundle_dir}" == "/" || ! "${release_id}" =~ ^[0-9]{8}T[0-9]{6}Z-[a-zA-Z0-9-]{4,40}$ ]]; then
  echo "Unsafe bundle path or release id" >&2
  exit 1
fi
units=(wiki-interest-collect.service wiki-interest-collect.timer wiki-interest-health.service wiki-interest-health.timer)
for required in app/package.json app/collect.mjs app/data-lib.mjs app/runtime-lib.mjs app/run-daily.mjs app/health.mjs app/src/ui-lib.js app/site/index.html ops/nginx-private.conf "${units[@]/#/ops/}"; do
  if [[ ! -f "${bundle_dir}/${required}" ]]; then
    echo "Missing bundle file: ${required}" >&2
    exit 1
  fi
done
command -v flock >/dev/null
command -v nginx >/dev/null
(
  export PATH=/usr/local/bin:/usr/bin:/bin
  node --input-type=module -e 'if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1)'
  node --input-type=module -e 'await import(process.argv[2]); await import(process.argv[3])' preflight "${bundle_dir}/app/run-daily.mjs" "${bundle_dir}/app/health.mjs"
)
systemd-analyze verify "${bundle_dir}/ops/wiki-interest-collect.service" "${bundle_dir}/ops/wiki-interest-collect.timer" "${bundle_dir}/ops/wiki-interest-health.service" "${bundle_dir}/ops/wiki-interest-health.timer"
nginx -t

if ! getent passwd wiki-interest >/dev/null; then
  useradd --system --no-create-home --shell /usr/sbin/nologin wiki-interest
fi
install -d -o root -g www-data -m 0750 /opt/wiki-interest /opt/wiki-interest/releases
install -d -o wiki-interest -g www-data -m 0750 /var/lib/wiki-interest /var/lib/wiki-interest/history /var/lib/wiki-interest/public
install -d -o root -g www-data -m 0750 /etc/wiki-interest
install -d -o root -g root -m 0700 /var/backups/wiki-interest-config
release_path="/opt/wiki-interest/releases/${release_id}"
if [[ -e "${release_path}" ]]; then
  echo "Refusing to overwrite release ${release_path}" >&2
  exit 1
fi
install -d -o root -g www-data -m 0750 "${release_path}"
cp -a "${bundle_dir}/app/." "${release_path}/"
chown -R root:www-data "${release_path}"
find "${release_path}" -type d -exec chmod 0750 {} +
find "${release_path}" -type f -exec chmod 0640 {} +

previous_release="$(readlink /opt/wiki-interest/current || true)"
config_path=/etc/nginx/sites-enabled/wiki-interest-private.conf
config_backup="/var/backups/wiki-interest-config/${release_id}.conf"
if [[ -e "${config_path}" ]]; then cp -a "${config_path}" "${config_backup}"; fi
declare -A was_enabled was_active
for unit in "${units[@]}"; do
  if [[ -e "/etc/systemd/system/${unit}" ]]; then
    cp -a "/etc/systemd/system/${unit}" "/var/backups/wiki-interest-config/${release_id}-${unit}"
  fi
  was_enabled["${unit}"]="$(systemctl is-enabled "${unit}" 2>/dev/null || true)"
  was_active["${unit}"]="$(systemctl is-active "${unit}" 2>/dev/null || true)"
done
rollback() {
  local failure=$?
  trap - ERR
  set +e
  systemctl stop wiki-interest-collect.timer wiki-interest-health.timer wiki-interest-collect.service wiki-interest-health.service
  systemctl disable wiki-interest-collect.timer wiki-interest-health.timer
  # Preserve rejected files and release for diagnosis; do not delete runtime data.
  [[ ! -e "${config_path}" ]] || mv "${config_path}" "/var/backups/wiki-interest-config/${release_id}.rejected.conf"
  [[ ! -e "${config_backup}" ]] || cp -a "${config_backup}" "${config_path}"
  if [[ -n "${previous_release}" ]]; then
    ln -s "${previous_release}" "/opt/wiki-interest/.rollback-${release_id}"
    mv -Tf "/opt/wiki-interest/.rollback-${release_id}" /opt/wiki-interest/current
  elif [[ -L /opt/wiki-interest/current ]]; then
    mv /opt/wiki-interest/current "/opt/wiki-interest/.failed-current-${release_id}"
  fi
  for unit in "${units[@]}"; do
    [[ ! -e "/etc/systemd/system/${unit}" ]] || mv "/etc/systemd/system/${unit}" "/var/backups/wiki-interest-config/${release_id}-rejected-${unit}"
    [[ ! -e "/var/backups/wiki-interest-config/${release_id}-${unit}" ]] || cp -a "/var/backups/wiki-interest-config/${release_id}-${unit}" "/etc/systemd/system/${unit}"
  done
  systemctl daemon-reload
  for unit in "${units[@]}"; do
    [[ "${was_enabled[$unit]}" != enabled ]] || systemctl enable "${unit}"
    [[ "${unit}" != *.timer || "${was_active[$unit]}" != active ]] || systemctl start "${unit}"
  done
  nginx -t && systemctl reload nginx
  echo "Activation failed; prior service configuration restored. New release and runtime data retained for diagnosis." >&2
  exit "${failure}"
}
trap rollback ERR
systemctl stop wiki-interest-collect.timer wiki-interest-health.timer 2>/dev/null || true
# A deployment must not switch source paths underneath a running collector.
systemctl stop wiki-interest-collect.service wiki-interest-health.service 2>/dev/null || true
ln -s "releases/${release_id}" "/opt/wiki-interest/.current-${release_id}"
mv -Tf "/opt/wiki-interest/.current-${release_id}" /opt/wiki-interest/current
install -o root -g root -m 0644 "${bundle_dir}/ops/nginx-private.conf" "${config_path}"
nginx -t
for unit in "${units[@]}"; do
  install -o root -g root -m 0644 "${bundle_dir}/ops/${unit}" "/etc/systemd/system/${unit}"
done
systemctl daemon-reload
systemctl reload nginx
systemctl start wiki-interest-collect.service
systemctl start wiki-interest-health.service
systemctl enable --now wiki-interest-collect.timer wiki-interest-health.timer
curl --fail --silent --show-error http://127.0.0.1:4174/data/snapshot.json >/dev/null
curl --fail --silent --show-error http://127.0.0.1:4174/data/status.json >/dev/null
trap - ERR
printf 'Installed %s. Private preview: http://127.0.0.1:4174/\n' "${release_id}"
