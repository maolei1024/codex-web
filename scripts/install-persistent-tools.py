#!/usr/bin/env python3
"""Provision external Linux AMD64 toolchains without modifying an image.

download runs on a networked maintenance machine. install/activate run on the
ml256 host with --data-dir pointing at the existing /data hostPath. Back up
env.sh, bin and the Deployment before activation. Create the Python venv inside
the container, at its final /data path, between install and activate.
"""
import argparse
import concurrent.futures
import lzma
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "codex-web-toolchains"})
    return urllib.request.urlopen(request, timeout=90)


def json_url(url):
    with fetch(url) as response:
        return json.load(response)


def digest(file, algorithm):
    value = hashlib.new(algorithm)
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def resolve():
    artifacts = []

    def github(repo, target, match):
        source = f"https://api.github.com/repos/{repo}/releases/latest"
        release = json_url(source)
        asset = next(a for a in release["assets"] if match(a["name"]))
        checksum = asset.get("digest")
        if not checksum or not checksum.startswith("sha256:"):
            raise RuntimeError(f"Missing publisher digest: {asset['name']}")
        artifacts.append(dict(name=asset["name"], url=asset["browser_download_url"],
                              algorithm="sha256", checksum=checksum[7:], kind="tar",
                              target=target + "/" + release["tag_name"],
                              version=release["tag_name"], source=source))

    github("astral-sh/uv", "uv", lambda n: n == "uv-x86_64-unknown-linux-gnu.tar.gz")
    for major in (8, 24, 25):
        github(f"adoptium/temurin{major}-binaries", f"java/{major}-releases",
               lambda n, v=major: n.startswith(f"OpenJDK{v}U-jdk_x64_linux_hotspot_") and n.endswith(".tar.gz"))
    source = "https://go.dev/dl/?mode=json&include=all"
    release = next(r for r in json_url(source) if r["version"] == "go1.27.2")
    asset = next(a for a in release["files"] if a["os"] == "linux" and a["arch"] == "amd64")
    artifacts.append(dict(name=asset["filename"], url="https://go.dev/dl/" + asset["filename"],
                          algorithm="sha256", checksum=asset["sha256"], kind="tar",
                          target="go/1.27.2", version="1.27.2", source=source))
    url = "https://archive.apache.org/dist/maven/maven-3/3.10.0/binaries/apache-maven-3.10.0-bin.tar.gz"
    with fetch(url + ".sha512") as response:
        checksum = response.read().decode().split()[0]
    artifacts.append(dict(name=url.rsplit("/", 1)[1], url=url, algorithm="sha512",
                          checksum=checksum, kind="tar", target="maven/3.10.0",
                          version="3.10.0", source=url + ".sha512"))

    required = {"curl", "libcurl4", "jq", "libjq1", "libonig5", "zip", "unzip"}
    packages = {}
    for base, distribution in (("https://deb.debian.org/debian", "bookworm"),
                               ("https://deb.debian.org/debian-security", "bookworm-security")):
        source = f"{base}/dists/{distribution}/main/binary-amd64/Packages.xz"
        with fetch(source) as response:
            index = lzma.decompress(response.read()).decode()
        for paragraph in index.split("\n\n"):
            fields = dict(line.split(": ", 1) for line in paragraph.splitlines()
                          if line and not line.startswith(" ") and ": " in line)
            name = fields.get("Package")
            if name not in required:
                continue
            old = packages.get(name)
            if old and subprocess.call(["dpkg", "--compare-versions", fields["Version"],
                                        "le", old["version"]]) == 0:
                continue
            packages[name] = dict(name=fields["Filename"].rsplit("/", 1)[1],
                                  url=base + "/" + fields["Filename"], algorithm="sha256",
                                  checksum=fields["SHA256"], kind="deb", target="system",
                                  version=fields["Version"], package=name, source=source)
    if set(packages) != required:
        raise RuntimeError("Missing Debian packages: " + str(required - set(packages)))
    return {"architecture": "linux-amd64", "python_minor": "3.13",
            "artifacts": artifacts + list(packages.values())}


def download(stage):
    manifest = stage / "versions.json"
    data = json.loads(manifest.read_text()) if manifest.exists() else resolve()
    manifest.write_text(json.dumps(data, indent=2) + "\n")

    def one(artifact):
        file = stage / artifact["name"]
        if file.exists() and digest(file, artifact["algorithm"]) == artifact["checksum"]:
            print("Verified cached", artifact["name"], flush=True)
            return
        for attempt in range(3):
            try:
                with fetch(artifact["url"]) as response, file.open("wb") as output:
                    shutil.copyfileobj(response, output)
                if digest(file, artifact["algorithm"]) != artifact["checksum"]:
                    raise RuntimeError("Checksum mismatch: " + artifact["name"])
                print("Downloaded and verified", artifact["name"], flush=True)
                return
            except Exception:
                file.unlink(missing_ok=True)
                if attempt == 2:
                    raise
                time.sleep(2)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(one, data["artifacts"]))


def owned(path):
    os.chown(path, 1000, 1000, follow_symlinks=False)
    if path.is_dir() and not path.is_symlink():
        for root, dirs, files in os.walk(path):
            for name in dirs + files:
                os.chown(Path(root) / name, 1000, 1000, follow_symlinks=False)


def link(path, target):
    if path.is_symlink() and os.readlink(path) == target:
        return
    if path.exists() or path.is_symlink():
        raise RuntimeError(f"Refusing to replace existing entry: {path}")
    path.symlink_to(target)
    owned(path)


def archive_filter(member, destination):
    # Some Ubuntu Python 3.10 data_filter backports resolve symlinks relative
    # to the archive root instead of the symlink's parent (Temurin 8 uses ../).
    if member.issym():
        if os.path.isabs(member.linkname):
            raise tarfile.AbsoluteLinkError(member)
        root = Path(destination).resolve()
        target = (root / Path(member.name).parent / member.linkname).resolve()
        if os.path.commonpath([root, target]) != str(root):
            raise tarfile.LinkOutsideDestinationError(member, str(target))
        filtered = tarfile.tar_filter(member, destination)
        return filtered.replace(mode=None, uid=None, gid=None, uname=None, gname=None)
    return tarfile.data_filter(member, destination)


def install(stage, data_dir):
    data = json.loads((stage / "versions.json").read_text())
    # Verify every input before making any persistent change.
    for artifact in data["artifacts"]:
        if digest(stage / artifact["name"], artifact["algorithm"]) != artifact["checksum"]:
            raise RuntimeError("Checksum mismatch: " + artifact["name"])
    root = data_dir / "tools"
    root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="extract-", dir=stage) as tmp:
        tmp = Path(tmp)
        system = tmp / "system"
        for artifact in data["artifacts"]:
            archive = stage / artifact["name"]
            if artifact["kind"] == "deb":
                subprocess.run(["dpkg-deb", "--extract", str(archive), str(system)], check=True)
                continue
            target = root / artifact["target"]
            marker = target / ".artifact-checksum"
            if marker.exists() and marker.read_text().strip() == artifact["checksum"]:
                continue
            if target.exists():
                raise RuntimeError(f"Unmanaged or different installation: {target}")
            unpack = tmp / artifact["name"]
            unpack.mkdir()
            with tarfile.open(archive) as tar:
                tar.extractall(unpack, filter=archive_filter)
            children = list(unpack.iterdir())
            if len(children) != 1 or not children[0].is_dir():
                raise RuntimeError("Expected one archive root: " + artifact["name"])
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(children[0]), target)
            marker.write_text(artifact["checksum"] + "\n")
            owned(target)
        target = root / "system"
        if target.exists():
            raise RuntimeError("Back up and remove the prior private system prefix before replacing it")
        shutil.move(str(system), target)
        owned(target)
    (root / "versions.json").write_text(json.dumps(data, indent=2) + "\n")
    owned(root / "versions.json")
    for name in ("uv", "java", "go", "maven"):
        os.chown(root / name, 1000, 1000)
    for major in (8, 24, 25):
        os.chown(root / "java" / f"{major}-releases", 1000, 1000)
    print("Installed verified artifacts; create the container Python venv before activate.")


def activate(stage, data_dir):
    root = data_dir / "tools"
    data = json.loads((root / "versions.json").read_text())
    scripts = Path(__file__).resolve().parent
    for source, target, mode in (("persistent-tools-env.sh", "env.sh", 0o644),
                                 ("persistent-tool", "persistent-tool", 0o755)):
        shutil.copyfile(scripts / source, root / target)
        (root / target).chmod(mode)
        owned(root / target)
    bin_dir = data_dir / "bin"
    bin_dir.mkdir(exist_ok=True)
    for artifact in data["artifacts"]:
        target = artifact["target"]
        if target.startswith("java/"):
            major = target.split("/")[1].split("-")[0]
            link(root / "java" / major, "/data/tools/" + target)
        elif target.startswith("uv/"):
            for name in ("uv", "uvx"):
                link(bin_dir / name, "/data/tools/" + target + "/" + name)
        elif target.startswith("go/"):
            for name in ("go", "gofmt"):
                link(bin_dir / name, "/data/tools/" + target + "/bin/" + name)
        elif target.startswith("maven/"):
            link(root / "maven/current", "/data/tools/" + target)
    names = "python python3 pip pip3 with-java java javac jar javadoc jshell jlink jpackage keytool mvn curl jq zip unzip java8 java24 java25 javac8 javac24 javac25"
    for name in names.split():
        link(bin_dir / name, "/data/tools/persistent-tool")
    print("Activated persistent tool entrypoints.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("download", "install", "activate"))
    parser.add_argument("--stage", type=Path, required=True, help="Task-specific /tmp directory")
    parser.add_argument("--data-dir", type=Path, help="Existing host directory mounted at /data")
    args = parser.parse_args()
    if not args.stage.is_dir():
        parser.error("--stage must already exist")
    if args.action == "download":
        download(args.stage)
    else:
        if not args.data_dir or not args.data_dir.is_dir():
            parser.error("--data-dir must be the existing hostPath directory")
        {"install": install, "activate": activate}[args.action](args.stage, args.data_dir)
