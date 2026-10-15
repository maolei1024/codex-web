import importlib.util
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "installer", Path(__file__).resolve().parents[1] / "scripts/install-persistent-tools.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class ArchiveFilterTests(unittest.TestCase):
    def test_temurin_parent_relative_symlink_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            member = tarfile.TarInfo("jdk/jre/lib/amd64/server/libjsig.so")
            member.type = tarfile.SYMTYPE
            member.linkname = "../libjsig.so"
            result = installer.archive_filter(member, directory)
            self.assertEqual(result.linkname, "../libjsig.so")
            self.assertIsNone(result.uid)

    def test_symlink_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            for target in ("../../../outside", "/etc/passwd"):
                with self.subTest(target=target):
                    member = tarfile.TarInfo("jdk/link")
                    member.type = tarfile.SYMTYPE
                    member.linkname = target
                    with self.assertRaises(tarfile.FilterError):
                        installer.archive_filter(member, directory)

    def test_file_escape_and_special_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            member = tarfile.TarInfo("../outside")
            with self.assertRaises(tarfile.FilterError):
                installer.archive_filter(member, directory)
            member = tarfile.TarInfo("device")
            member.type = tarfile.CHRTYPE
            with self.assertRaises(tarfile.FilterError):
                installer.archive_filter(member, directory)


if __name__ == "__main__":
    unittest.main()
