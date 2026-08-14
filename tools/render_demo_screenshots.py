"""Render privacy-safe README previews from the dashboard's design language.

These are illustrative screens with synthetic data, not captures from a real
vehicle or deployment. Keeping the renderer in the repository makes the
assets reproducible and prevents private telemetry from entering Git history.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import math

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)

S = 2
W, H = 432 * S, 936 * S

C = {
    "bg": "#eef3f4", "card": "#ffffff", "alt": "#f4f8f8",
    "border": "#dce7e7", "text": "#0b1f2a", "secondary": "#405762",
    "muted": "#687f88", "primary": "#0f766e", "primary_dark": "#115e59",
    "primary_light": "#e6fffb", "green": "#10b981", "green_light": "#ecfdf5",
    "blue": "#2563eb", "blue_light": "#eff6ff", "amber": "#d97706",
    "amber_light": "#fffbeb", "violet": "#6657c7", "violet_light": "#f3f0ff",
    "red": "#ef4444", "red_light": "#fef2f2", "indigo": "#3258a8",
}

FONT_REG = Path("C:/Windows/Fonts/msyh.ttc")
FONT_BOLD = Path("C:/Windows/Fonts/msyhbd.ttc")


def font(size, bold=False):
    return ImageFont.truetype(str(FONT_BOLD if bold and FONT_BOLD.exists() else FONT_REG), size * S)


def txt(d, xy, text, size=14, color=None, bold=False, anchor=None):
    d.text((xy[0] * S, xy[1] * S), text, font=font(size, bold), fill=color or C["text"], anchor=anchor)


def rr(d, box, radius=18, fill=None, outline=None, width=1):
    d.rounded_rectangle(tuple(v * S for v in box), radius * S, fill=fill, outline=outline, width=width * S)


def line(d, pts, fill, width=1):
    d.line([(x * S, y * S) for x, y in pts], fill=fill, width=width * S, joint="curve")


def base(active, accent=None):
    im = Image.new("RGB", (W, H), C["bg"])
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, W, 42 * S), fill="#f8fbfb")
    txt(d, (20, 21), "09:41", 12, C["secondary"], True, "lm")
    txt(d, (410, 21), "●  Wi-Fi  82%", 10, C["secondary"], False, "rm")
    rr(d, (334, 52, 412, 78), 13, C["primary_light"])
    txt(d, (373, 65), "示例数据", 10, C["primary_dark"], True, "mm")
    if accent:
        d.rectangle((0, 42 * S, 4 * S, 844 * S), fill=accent)
    nav(d, active)
    return im, d


def nav(d, active):
    y = 850
    d.rectangle((0, y * S, W, H), fill=C["card"])
    d.line((0, y * S, W, y * S), fill=C["border"], width=S)
    tabs = [("总览", "◉"), ("行程", "⌁"), ("电池", "▰"), ("仪表板", "◇"), ("更多", "▦")]
    for i, (label, icon) in enumerate(tabs):
        x = 43 + i * 86
        on = label == active
        if on:
            rr(d, (x - 22, y + 8, x + 22, y + 38), 16, C["primary"])
        txt(d, (x, y + 23), icon, 16, "#ffffff" if on else C["muted"], True, "mm")
        txt(d, (x, y + 55), label, 10, C["primary"] if on else C["muted"], True, "mm")


def header(d, eyebrow, title, subtitle=""):
    txt(d, (20, 58), eyebrow, 11, C["primary"], True)
    txt(d, (20, 78), title, 25, C["text"], True)
    if subtitle:
        txt(d, (20, 114), subtitle, 12, C["muted"])


def section(d, y, title, badge=None, color=None):
    txt(d, (20, y), title, 16, C["text"], True)
    if badge:
        w = max(48, len(badge) * 11 + 18)
        rr(d, (412 - w, y - 2, 412, y + 24), 13, C["green_light"] if color == "green" else C["alt"])
        txt(d, (412 - w / 2, y + 11), badge, 10, C["primary_dark"] if color == "green" else C["muted"], True, "mm")


def metric(d, box, label, value, unit="", tint=None, value_color=None):
    rr(d, box, 16, tint or C["card"], C["border"])
    x1, y1, x2, _ = box
    txt(d, (x1 + 14, y1 + 14), label, 11, C["muted"])
    txt(d, (x1 + 14, y1 + 40), value, 22, value_color or C["text"], True)
    if unit:
        txt(d, (x2 - 14, y1 + 48), unit, 10, C["muted"], False, "ra")


def ring(d, center, radius, pct, color):
    cx, cy = center
    box = ((cx-radius)*S, (cy-radius)*S, (cx+radius)*S, (cy+radius)*S)
    d.arc(box, -90, 269, fill=C["border"], width=12*S)
    d.arc(box, -90, -90 + 360*pct, fill=color, width=12*S)


def save(im, name):
    im.save(OUT / name, optimize=True)


def overview():
    im, d = base("总览", C["primary"])
    header(d, "下午好", "示例车辆", "数据刚刚更新 · 中继与保护板在线")
    rr(d, (20, 142, 412, 408), 26, C["primary"])
    # subtle concentric decoration
    d.ellipse((230*S, 125*S, 510*S, 405*S), outline="#228d83", width=2*S)
    ring(d, (128, 265), 75, .76, "#8df2d4")
    txt(d, (128, 247), "76", 44, "#ffffff", True, "mm")
    txt(d, (128, 285), "%", 13, "#d7fff5", True, "mm")
    txt(d, (244, 191), "预计续航", 12, "#c9f7ee")
    txt(d, (244, 219), "86.4", 34, "#ffffff", True)
    txt(d, (342, 239), "km", 11, "#c9f7ee")
    rr(d, (242, 275, 374, 311), 18, "#1c857c")
    txt(d, (308, 293), "电量充足 · 可出行", 11, "#ffffff", True, "mm")
    txt(d, (244, 337), "静置功率", 10, "#c9f7ee")
    txt(d, (244, 358), "2.1 W", 18, "#ffffff", True)
    section(d, 438, "车辆状态", "实时", "green")
    metric(d, (20, 472, 206, 556), "总电压", "58.7", "V", C["card"])
    metric(d, (226, 472, 412, 556), "电池温度", "27.4", "°C", C["card"])
    metric(d, (20, 572, 206, 656), "前轮胎压", "2.18", "bar", C["card"])
    metric(d, (226, 572, 412, 656), "后轮胎压", "2.25", "bar", C["card"])
    rr(d, (20, 674, 412, 824), 18, C["card"], C["border"])
    txt(d, (36, 691), "最近位置", 11, C["muted"])
    txt(d, (36, 716), "展览路街道附近", 16, C["text"], True)
    d.rectangle((286*S, 691*S, 396*S, 808*S), fill="#d7ece8")
    line(d, [(295,790),(315,758),(334,766),(351,721),(389,707)], "#77b6ab", 5)
    d.ellipse((347*S, 718*S, 359*S, 730*S), fill=C["primary"])
    txt(d, (36, 757), "今天 12.6 km  ·  最高 46.8 km/h", 11, C["secondary"])
    save(im, "overview.png")


def battery():
    im, d = base("电池", C["green"])
    header(d, "电池分析", "当前可用电量", "示例车辆 · 数据刚刚更新")
    rr(d, (20, 138, 412, 352), 24, C["card"], C["border"])
    ring(d, (121, 245), 70, .76, C["green"])
    txt(d, (121, 230), "76", 43, C["text"], True, "mm")
    txt(d, (121, 267), "%", 12, C["muted"], True, "mm")
    txt(d, (224, 187), "保护板实测", 11, C["primary"], True)
    txt(d, (224, 218), "37.8 Ah", 26, C["text"], True)
    txt(d, (224, 254), "满充容量 49.8 Ah", 11, C["muted"])
    rr(d, (224, 284, 375, 319), 17, C["green_light"])
    txt(d, (300, 301), "电池状态良好", 11, C["primary_dark"], True, "mm")
    section(d, 382, "关键状态", "实时", "green")
    metric(d, (20, 416, 206, 504), "总电压", "58.7", "V")
    metric(d, (226, 416, 412, 504), "实时电流", "-0.04", "A")
    metric(d, (20, 520, 206, 608), "最高温度", "27.4", "°C")
    metric(d, (226, 520, 412, 608), "单体压差", "18", "mV", C["green_light"], C["primary_dark"])
    for y, title, badge in [(634,"单体电压","14 串"),(694,"电压趋势","24 小时"),(754,"充电记录","8 次"),(814,"高级信息","调试")]:
        rr(d, (20, y, 412, y+48), 15, C["card"], C["border"])
        txt(d, (38, y+24), title, 13, C["text"], True, "lm")
        txt(d, (368, y+24), badge + "  ›", 10, C["muted"], False, "rm")
    save(im, "battery.png")


def rides():
    im, d = base("行程", C["violet"])
    header(d, "月度汇总", "2026 年 8 月", "按日期分组，长列表仍然容易浏览")
    rr(d, (20, 140, 412, 300), 22, C["violet"], None)
    txt(d, (38, 165), "本月骑行", 11, "#e7e3ff")
    txt(d, (38, 195), "126.8", 34, "#ffffff", True)
    txt(d, (152, 215), "km", 11, "#e7e3ff")
    txt(d, (248, 165), "共 12 次", 11, "#e7e3ff")
    txt(d, (248, 194), "平均 10.6 km", 17, "#ffffff", True)
    d.rectangle((38*S, 252*S, 387*S, 254*S), fill="#8d80d8")
    txt(d, (38, 270), "累计骑行 4 小时 18 分", 11, "#e7e3ff")
    entries = [
        ("今天 · 8 月 12 日", [("18:26 — 18:51","12.6 km","46.8 km/h"),("08:14 — 08:32","7.4 km","38.2 km/h")]),
        ("昨天 · 8 月 11 日", [("19:02 — 19:37","18.3 km","44.1 km/h")]),
        ("8 月 9 日 · 星期日", [("14:18 — 15:06","24.7 km","49.3 km/h")]),
    ]
    y=326
    for day, rows in entries:
        txt(d, (20, y), day, 13, C["secondary"], True)
        y += 30
        for time, dist, speed in rows:
            rr(d, (20, y, 412, y+84), 17, C["card"], C["border"])
            d.ellipse((38*S,(y+20)*S,50*S,(y+32)*S), fill=C["violet"])
            txt(d, (61, y+17), time, 12, C["text"], True)
            txt(d, (61, y+47), "城市道路 · 数据完整", 10, C["muted"])
            txt(d, (392, y+19), dist, 16, C["text"], True, "ra")
            txt(d, (392, y+51), "最高 " + speed, 10, C["muted"], False, "ra")
            y += 96
        y += 10
    save(im, "rides.png")


def dashboard():
    im, d = base("仪表板", C["indigo"])
    header(d, "实时仪表", "骑行数据", "本机 GPS 与保护板状态分开展示")
    rr(d, (20, 138, 412, 404), 25, "#16283c")
    ring(d, (138, 265), 82, .62, "#73a6ff")
    txt(d, (138, 244), "32", 54, "#ffffff", True, "mm")
    txt(d, (138, 291), "km/h", 12, "#b8c9d9", True, "mm")
    txt(d, (268, 183), "保护板 SOC", 10, "#b8c9d9")
    txt(d, (268, 207), "76%", 27, "#ffffff", True)
    txt(d, (268, 260), "实时功率", 10, "#b8c9d9")
    txt(d, (268, 284), "1.86 kW", 22, "#ffffff", True)
    txt(d, (268, 337), "本次极速", 10, "#b8c9d9")
    txt(d, (268, 361), "46.8 km/h", 18, "#ffffff", True)
    section(d, 434, "实时电池", "5 秒刷新", "green")
    metric(d, (20, 470, 134, 560), "电压", "57.9", "V")
    metric(d, (150, 470, 278, 560), "电流", "-32.1", "A")
    metric(d, (294, 470, 412, 560), "温度", "29.2", "°C")
    section(d, 594, "骑行状态")
    rr(d, (20, 630, 412, 735), 18, C["card"], C["border"])
    txt(d, (40, 653), "GPS", 10, C["muted"]); txt(d, (40, 678), "高精度", 15, C["text"], True)
    txt(d, (165, 653), "加速度", 10, C["muted"]); txt(d, (165, 678), "+0.18 m/s²", 15, C["text"], True)
    txt(d, (310, 653), "方向", 10, C["muted"]); txt(d, (310, 678), "东北", 15, C["text"], True)
    rr(d, (20, 753, 412, 823), 16, C["blue_light"], "#bfdbfe")
    txt(d, (38, 776), "数据来源", 10, C["blue"])
    txt(d, (38, 800), "速度：本机 GPS  ·  电池：尾箱中继 BMS", 12, C["text"], True)
    save(im, "dashboard.png")


def more():
    im, d = base("更多", C["primary"])
    header(d, "功能与设备", "更多", "日常功能在前，调试工具收进高级入口")
    cards=[
        ("设置", "通知、阈值、账号与显示偏好", C["primary_light"], C["primary"]),
        ("车辆监控", "查看摄像头状态与拍照记录", C["blue_light"], C["blue"]),
        ("中继设备", "连接状态、电量和应用更新", C["green_light"], C["green"]),
        ("数据与隐私", "本地数据、导出与隐私说明", C["violet_light"], C["violet"]),
    ]
    y=144
    for title, sub, bg, ac in cards:
        rr(d, (20,y,412,y+104), 20, C["card"], C["border"])
        rr(d, (38,y+23,92,y+77), 17, bg)
        d.ellipse((56*S,(y+41)*S,74*S,(y+59)*S), fill=ac)
        txt(d, (112,y+28), title, 16, C["text"], True)
        txt(d, (112,y+58), sub, 11, C["muted"])
        txt(d, (391,y+52), "›", 22, C["muted"], False, "mm")
        y += 120
    section(d, 636, "设备概览")
    rr(d, (20,670,412,782), 18, C["card"], C["border"])
    txt(d, (38,694), "尾箱中继", 13, C["text"], True)
    rr(d, (322,687,391,715), 14, C["green_light"])
    txt(d, (356,701), "运行中", 10, C["primary_dark"], True, "mm")
    txt(d, (38,731), "手机电量 82%", 11, C["secondary"])
    txt(d, (205,731), "保护板已连接", 11, C["secondary"])
    txt(d, (38,756), "应用 v1.6.7 · 数据刚刚更新", 10, C["muted"])
    save(im, "more.png")


def settings():
    im, d = base("更多", C["primary"])
    txt(d, (20, 66), "‹  返回", 12, C["primary"], True)
    txt(d, (20, 98), "设置", 26, C["text"], True)
    txt(d, (20, 132), "保持日常选项简洁，技术信息默认折叠", 11, C["muted"])
    groups=[
        ("通知与提醒", [("低电量提醒","低于 20% 时通知",True),("充电完成提醒","充满后通知",True),("温度告警","超过设定阈值时通知",True)]),
        ("显示与体验", [("智能提示","根据车辆状态显示建议",True),("胎压显示","仅显示新鲜数据",True)]),
        ("账号与连接", [("服务端连接","已连接 · 示例服务器",None)]),
    ]
    y=172
    for title, rows in groups:
        txt(d, (20,y), title, 14, C["secondary"], True); y+=28
        rr(d, (20,y,412,y+len(rows)*64), 18, C["card"], C["border"])
        for i,(label,sub,on) in enumerate(rows):
            yy=y+i*64
            if i: d.line((36*S,yy*S,396*S,yy*S), fill=C["border"], width=S)
            txt(d, (38,yy+14), label, 13, C["text"], True)
            txt(d, (38,yy+38), sub, 10, C["muted"])
            if on is not None:
                rr(d, (349,yy+18,390,yy+42), 13, C["primary"] if on else C["border"])
                d.ellipse(((372 if on else 352)*S,(yy+20)*S,(388 if on else 368)*S,(yy+40)*S), fill="#ffffff")
            else:
                txt(d, (390,yy+31), "›", 20, C["muted"], False, "mm")
        y += len(rows)*64 + 34
    rr(d, (20, y, 412, y+62), 17, C["alt"], C["border"])
    txt(d, (38,y+20), "高级与开发者选项", 13, C["text"], True)
    txt(d, (391,y+31), "›", 20, C["muted"], False, "mm")
    txt(d, (38,y+42), "刷新频率、协议、数据源和远控工具", 9, C["muted"])
    save(im, "settings.png")


def widget():
    w,h=1120,410
    im=Image.new("RGB",(w,h),"#dce6e8")
    d=ImageDraw.Draw(im)
    # shadow and body
    d.rounded_rectangle((28,30,1092,392),48,fill="#c7d3d6")
    d.rounded_rectangle((18,18,1082,380),48,fill=C["card"],outline=C["border"],width=3)
    d.rounded_rectangle((18,18,30,380),8,fill=C["primary"])
    d.text((62,54),"示例车辆",font=ImageFont.truetype(str(FONT_BOLD),42),fill=C["text"])
    d.rounded_rectangle((294,58,406,94),18,fill=C["primary_light"])
    d.text((350,76),"数据新鲜",font=ImageFont.truetype(str(FONT_BOLD),18),fill=C["primary_dark"],anchor="mm")
    d.text((62,132),"76%",font=ImageFont.truetype(str(FONT_BOLD),64),fill=C["primary"])
    d.text((260,157),"剩余 86.4 km",font=ImageFont.truetype(str(FONT_BOLD),29),fill=C["text"],anchor="lm")
    d.rounded_rectangle((62,218,465,244),13,fill=C["border"])
    d.rounded_rectangle((62,218,368,244),13,fill=C["primary"])
    d.text((62,289),"展览路街道附近",font=ImageFont.truetype(str(FONT_REG),23),fill=C["muted"])
    # Stylised electric scooter silhouette and tyre callouts.
    d.line((690,260,900,260),fill="#203b47",width=14)
    d.line((775,260,812,159,875,159,902,260),fill="#203b47",width=13,joint="curve")
    d.line((812,159,774,118),fill="#203b47",width=10)
    d.ellipse((676,238,732,294),outline="#203b47",width=12)
    d.ellipse((880,238,936,294),outline="#203b47",width=12)
    d.line((704,231,646,172,596,172),fill=C["primary"],width=4)
    d.line((908,231,955,172,1004,172),fill=C["primary"],width=4)
    d.text((590,172),"前 2.18 bar",font=ImageFont.truetype(str(FONT_BOLD),20),fill=C["primary_dark"],anchor="rm")
    d.text((1010,172),"后 2.25 bar",font=ImageFont.truetype(str(FONT_BOLD),20),fill=C["primary_dark"],anchor="lm")
    d.text((1046,342),"示例数据",font=ImageFont.truetype(str(FONT_REG),17),fill=C["muted"],anchor="rm")
    im.save(OUT/"widget.png",optimize=True)


def gallery():
    names=["overview.png","battery.png","rides.png","dashboard.png","more.png","settings.png"]
    thumbs=[]
    for n in names:
        im=Image.open(OUT/n)
        im.thumbnail((350,760),Image.Resampling.LANCZOS)
        thumbs.append(im.copy())
    canvas=Image.new("RGB",(2340,1760),"#e8eff0")
    d=ImageDraw.Draw(canvas)
    d.text((90,58),"WheelSense",font=ImageFont.truetype(str(FONT_BOLD),52),fill=C["text"])
    d.text((90,126),"可信数据 · 离线连续 · 自托管隐私",font=ImageFont.truetype(str(FONT_REG),27),fill=C["secondary"])
    labels=["总览","电池","行程","仪表板","更多","设置"]
    for i,(im,label) in enumerate(zip(thumbs,labels)):
        row,col=divmod(i,3)
        x=110+col*750; y=205+row*770
        d.rounded_rectangle((x-18,y-18,x+im.width+18,y+im.height+58),30,fill="#cfdbdd")
        canvas.paste(im,(x,y))
        d.text((x+im.width/2,y+im.height+28),label,font=ImageFont.truetype(str(FONT_BOLD),23),fill=C["secondary"],anchor="mm")
    canvas.save(OUT/"gallery.png",optimize=True)


if __name__ == "__main__":
    overview(); battery(); rides(); dashboard(); more(); settings(); widget(); gallery()
    print(f"Rendered demo assets in {OUT}")
