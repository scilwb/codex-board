#!/usr/bin/python3
"""A large, non-focusing desktop banner for Codex Board on GTK 3 / X11.

The parent writes a single JSON object to stdin and owns process lifetime.
Only protocol events go to stdout; failure messages never include the payload.
"""

import json
import signal
import sys


STATUSES = {
    "waiting": ("Codex 需要你回答", "#ffc66b", 25000),
    "completed": ("Codex 本轮已结束", "#83deb2", 18000),
    "test": ("Codex 桌面提醒测试", "#8fc4ff", 12000),
}
MAX_INPUT_BYTES = 32768


def protocol(event):
    try:
        print(json.dumps(event, ensure_ascii=False), flush=True)
    except (BrokenPipeError, OSError):
        pass


def plain_text(value, limit):
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:limit]


def read_payload(stream):
    raw = stream.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("Payload too large.")
    payload = json.loads(raw)
    if not isinstance(payload, dict) or payload.get("status") not in STATUSES:
        raise ValueError("Invalid banner payload.")
    status = payload["status"]
    duration = payload.get("durationMs", STATUSES[status][2])
    if isinstance(duration, bool) or not isinstance(duration, (int, float)):
        raise ValueError("Invalid duration.")
    duration = int(duration)
    return {
        "status": status,
        "title": plain_text(payload.get("title"), 240) or "未命名对话",
        "body": plain_text(payload.get("body"), 120),
        "openable": payload.get("openable") is True,
        "durationMs": max(3000, min(120000, duration)),
    }


def desktop():
    import gi

    gi.require_version("Gtk", "3.0")
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk, Gio, GLib, Gtk, Pango

    initialized, _ = Gtk.init_check([])
    display = Gdk.Display.get_default()
    if not initialized or display is None or display.get_n_monitors() < 1:
        raise RuntimeError("No desktop display available.")
    # GTK's explicit placement and above-window hints require X11. The parent
    # can fall back to native libnotify on desktops that cannot place this banner.
    if type(display).__name__ != "X11Display":
        raise RuntimeError("The large desktop banner requires an X11 session.")
    return Gtk, Gdk, GLib, Pango, Gio, display


def notifications_muted(Gio):
    # Respect GNOME's existing Do Not Disturb setting. Never write settings or
    # silently disable a user's notification preferences.
    try:
        source = Gio.SettingsSchemaSource.get_default()
        schema = source.lookup("org.gnome.desktop.notifications", True) if source else None
        if schema is None or not schema.has_key("show-banners"):
            return False
        settings = Gio.Settings.new_full(schema, None, None)
        return not settings.get_boolean("show-banners")
    except Exception:
        return False


def show_banner(payload, environment):
    Gtk, Gdk, GLib, Pango, _Gio, display = environment
    heading, accent, _ = STATUSES[payload["status"]]
    monitor = display.get_primary_monitor() or display.get_monitor(0)
    workarea = monitor.get_workarea()
    width = max(320, min(760, workarea.width - 48))

    window = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
    window.set_title("Codex Board Desktop Reminder")
    window.set_role("codex-board-desktop-reminder")
    window.set_type_hint(Gdk.WindowTypeHint.NOTIFICATION)
    window.set_decorated(False)
    window.set_resizable(False)
    window.set_accept_focus(False)
    window.set_focus_on_map(False)
    window.set_skip_taskbar_hint(True)
    window.set_skip_pager_hint(True)
    window.set_keep_above(True)
    window.stick()
    window.set_default_size(width, -1)
    window.set_size_request(width, -1)
    window.set_position(Gtk.WindowPosition.NONE)
    window.get_style_context().add_class("codex-banner-window")
    screen = window.get_screen()
    visual = screen.get_rgba_visual()
    if visual is not None and screen.is_composited():
        window.set_visual(visual)
        window.set_app_paintable(True)

    css = Gtk.CssProvider()
    css.load_from_data(("""
        .codex-banner-window { background-color: transparent; }
        .codex-banner-card {
            background-color: #17202e;
            border: 2px solid ACCENT;
            border-radius: 16px;
            color: #f6f8fd;
            padding: 22px 26px;
            font-family: Sans;
        }
        .codex-banner-status { font-size: 26px; font-weight: 700; color: ACCENT; }
        .codex-banner-title { font-size: 22px; font-weight: 600; color: #f6f8fd; }
        .codex-banner-body { font-size: 18px; color: #c9d4e4; }
        .codex-banner-close {
            background: transparent;
            border: none;
            box-shadow: none;
            color: #d0d9e7;
            font-size: 27px;
            padding: 0 4px;
            min-width: 34px;
            min-height: 34px;
        }
        .codex-banner-close:hover { background: #344158; border-radius: 8px; }
        .codex-banner-open {
            background: #2b3a50;
            border: 1px solid #617692;
            border-radius: 9px;
            box-shadow: none;
            color: #f6f8fd;
            font-size: 18px;
            font-weight: 600;
            padding: 8px 20px;
        }
        .codex-banner-open:hover { background: #3a4e6a; }
    """.replace("ACCENT", accent)).encode("utf-8"))
    Gtk.StyleContext.add_provider_for_screen(screen, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)

    card = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14)
    card.get_style_context().add_class("codex-banner-card")
    window.add(card)

    header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=18)
    status_label = Gtk.Label(label=heading, xalign=0)
    status_label.set_hexpand(True)
    status_label.get_style_context().add_class("codex-banner-status")
    header.pack_start(status_label, True, True, 0)

    closing = False

    def close(*_args):
        nonlocal closing
        if not closing:
            closing = True
            window.destroy()
            Gtk.main_quit()
        return GLib.SOURCE_REMOVE

    close_button = Gtk.Button(label="×")
    close_button.set_can_focus(False)
    close_button.set_tooltip_text("关闭提醒")
    close_button.get_accessible().set_name("关闭提醒")
    close_button.get_style_context().add_class("codex-banner-close")
    close_button.connect("clicked", close)
    header.pack_end(close_button, False, False, 0)
    card.pack_start(header, False, False, 0)

    def wrapped_label(text, class_name, lines):
        label = Gtk.Label(label=text, xalign=0)
        label.set_line_wrap(True)
        label.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR)
        label.set_ellipsize(Pango.EllipsizeMode.END)
        label.set_lines(lines)
        label.set_max_width_chars(1)
        label.set_hexpand(True)
        label.get_style_context().add_class(class_name)
        return label

    card.pack_start(wrapped_label(payload["title"], "codex-banner-title", 2), False, False, 0)
    if payload["body"]:
        card.pack_start(wrapped_label(payload["body"], "codex-banner-body", 2), False, False, 0)
    if payload["openable"]:
        footer = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        open_button = Gtk.Button(label="打开对话")
        open_button.set_can_focus(False)
        open_button.get_style_context().add_class("codex-banner-open")

        def open_conversation(_button):
            protocol({"event": "open"})
            close()

        open_button.connect("clicked", open_conversation)
        footer.pack_end(open_button, False, False, 0)
        card.pack_start(footer, False, False, 0)

    def place(*_args):
        allocated_width, _ = window.get_size()
        window.move(workarea.x + (workarea.width - allocated_width) // 2, workarea.y + 20)
        return GLib.SOURCE_REMOVE

    shown = False

    def mapped(*_args):
        nonlocal shown
        if not shown:
            shown = True
            place()
            protocol({"event": "shown"})
            GLib.timeout_add(payload["durationMs"], close)
        return False

    window.connect("map-event", mapped)
    window.connect("size-allocate", place)
    window.connect("delete-event", close)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, close)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, close)
    place()
    window.show_all()
    Gtk.main()


def main():
    checking = sys.argv[1:] == ["--check"]
    if sys.argv[1:] and not checking:
        print("Unsupported banner arguments.", file=sys.stderr)
        return 2
    try:
        payload = None if checking else read_payload(sys.stdin.buffer)
        environment = desktop()
        if checking:
            protocol({"available": True, "backend": "gtk3", "monitorCount": environment[-1].get_n_monitors()})
        elif notifications_muted(environment[-2]):
            protocol({"event": "suppressed"})
        else:
            show_banner(payload, environment)
        return 0
    except Exception:
        print("Desktop banner unavailable: check its input, GTK 3 and desktop display.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
