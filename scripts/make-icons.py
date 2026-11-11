#!/usr/bin/env python3
"""Иконки GoatDrey AI.

Источник — фото пользователя: assets/icon/source.jpg (или .png/.jpeg/.webp).
Делает квадратный кроп с упором на лицо (центр по горизонтали, верхняя треть по вертикали
для вертикальных фото), затем PNG 256/128/64/32/16 и многоразмерный icon.ico для Windows.

Если фото нет — временная заглушка-монограмма, чтобы сборка не падала.
Запуск:  python scripts/make-icons.py [путь_к_фото]
"""
import sys, os
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'icon')
SIZES = [256, 128, 64, 48, 32, 16]

def find_source(argv):
    if len(argv) > 1 and os.path.exists(argv[1]):
        return argv[1]
    for ext in ('jpg', 'jpeg', 'png', 'webp'):
        p = os.path.join(OUT, 'source.' + ext)
        if os.path.exists(p):
            return p
    return None

def face_crop(im):
    im = ImageOps.exif_transpose(im).convert('RGB')
    w, h = im.size
    side = min(w, h)
    left = (w - side) // 2
    # Вертикальное фото: лицо обычно в верхней части — смещаем окно вверх (30% свободного места сверху).
    top = int((h - side) * 0.30) if h > w else 0
    return im.crop((left, top, left + side, top + side))

def placeholder():
    im = Image.new('RGB', (512, 512), '#F4F1EA')
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((24, 24, 488, 488), radius=56, outline='#1C1917', width=10)
    font = None
    for f in ['/usr/share/fonts/truetype/sand-box/google/IBM Plex Serif/IBMPlexSerif-SemiBoldItalic.ttf', 'C:/Windows/Fonts/georgiab.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf']:
        if os.path.exists(f):
            font = ImageFont.truetype(f, 250); break
    d.text((256, 262), 'GD', fill='#1C1917', font=font, anchor='mm')
    d.line((150, 392, 362, 392), fill='#C2410C', width=14)
    return im

def main():
    os.makedirs(OUT, exist_ok=True)
    src = find_source(sys.argv)
    if src:
        base = face_crop(Image.open(src))
        print('Фото:', src, '→ кроп', base.size)
    else:
        base = placeholder()
        print('ВНИМАНИЕ: фото не найдено (assets/icon/source.jpg) — сделал временную монограмму.')
    big = base.resize((512, 512), Image.LANCZOS)
    big.save(os.path.join(OUT, 'icon-512.png'))
    for s in SIZES:
        big.resize((s, s), Image.LANCZOS).save(os.path.join(OUT, f'icon-{s}.png'))
    big.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, 'icon.ico'), sizes=[(s, s) for s in SIZES])
    big.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, 'icon.png'))
    print('Готово:', OUT)

if __name__ == '__main__':
    main()
