"""Publish only GRD's RDP item in the volatile Secret Service session collection."""
import getpass
import os
from pathlib import Path
import sys

import gi
gi.require_version("Secret", "1")
from gi.repository import GLib, Secret

schema = Secret.Schema.new("org.gnome.RemoteDesktop.RdpCredentials",
                           Secret.SchemaFlags.NONE, {})
service = Secret.Service.get_sync(Secret.ServiceFlags.OPEN_SESSION, None)
# Loading secrets skips locked items. Do not request SEARCH_UNLOCK: diagnostics
# and boot must never prompt for a login keyring password.
items = service.search_sync(schema, {}, Secret.SearchFlags.ALL |
                            Secret.SearchFlags.LOAD_SECRETS, None)
def credential(item):
    value = item.get_secret()
    if not value:
        return None
    try:
        return GLib.Variant.parse(GLib.VariantType.new("a{sv}"),
                                  value.get_text(), None, None).unpack()
    except (GLib.Error, TypeError):
        return None

if sys.argv[1:] == ["check"]:
    entries = [credential(item) for item in items if not item.get_locked()]
    sys.exit(0 if entries and all(e and e.get("username") == getpass.getuser()
                                  and e.get("password") for e in entries) else 1)

if sys.argv[1:] == ["retire"]:
    collection = Secret.Collection.for_alias_sync(service, Secret.COLLECTION_SESSION,
                                                 Secret.CollectionFlags.NONE, None)
    if collection:
        for item in items:
            if item.get_object_path().startswith(collection.get_object_path() + "/") and item.get_label() == "Fleet GNOME Remote Desktop RDP credentials":
                item.delete_sync(None)
    sys.exit(0)

password = (Path(os.environ["CREDENTIALS_DIRECTORY"]) / "rdp-password").read_text()
expected = {"username": getpass.getuser(), "password": password}
collection = Secret.Collection.for_alias_sync(service, Secret.COLLECTION_SESSION,
                                             Secret.CollectionFlags.NONE, None)
if not collection or collection.get_locked():
    sys.exit("RDP session collection unavailable")
already_published = False
for item in items:
    if item.get_locked():
        continue
    if item.get_object_path().startswith(collection.get_object_path() + "/"):
        already_published |= credential(item) == expected
    elif credential(item) != expected:
        sys.exit("RDP credential conflicts with an existing unlocked desktop credential")
if already_published:
    sys.exit(0)
variant = GLib.Variant("a{sv}", {k: GLib.Variant("s", v) for k, v in expected.items()})
if not Secret.password_store_sync(schema, {}, Secret.COLLECTION_SESSION,
                                  "Fleet GNOME Remote Desktop RDP credentials",
                                  variant.print_(True), None):
    sys.exit("RDP credential unavailable")
