import os
import sys
from PIL import Image

def apply_icon(opt_name):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(script_dir)
    icons_dir = os.path.join(root, 'assets', 'icons')
    src_512 = os.path.join(icons_dir, f'{opt_name}_512.png')
    if not os.path.exists(src_512):
        print(f"Error: {src_512} does not exist.")
        return False
    im512 = Image.open(src_512).convert('RGBA')

    # 1. build/appicon.png (512x512)
    appicon_png = os.path.join(root, 'apps', 'client', 'build', 'appicon.png')
    im512.save(appicon_png, 'PNG')

    # 2. build/windows/icon.ico (multi-size layer)
    ico_path = os.path.join(root, 'apps', 'client', 'build', 'windows', 'icon.ico')
    ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    im512.save(ico_path, format='ICO', sizes=ico_sizes)

    # 3. Darwin dmg-file-icon.png & icons.icns
    dmg_icon = os.path.join(root, 'apps', 'client', 'build', 'darwin', 'dmg-file-icon.png')
    im512.resize((256, 256), Image.Resampling.LANCZOS).save(dmg_icon, 'PNG')
    icns_path = os.path.join(root, 'apps', 'client', 'build', 'darwin', 'icons.icns')
    try:
        im512.save(icns_path, format='ICNS')
    except Exception as e:
        print('ICNS save fallback:', e)

    # 4. iOS icon
    ios_icon = os.path.join(root, 'apps', 'client', 'build', 'ios', 'icon.png')
    im512.save(ios_icon, 'PNG')

    # 5. Frontend public assets
    fe_public = os.path.join(root, 'apps', 'client', 'frontend', 'public')
    im512.save(os.path.join(fe_public, 'appicon.png'), 'PNG')
    im512.save(os.path.join(fe_public, 'favicon.ico'), format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])
    im512.save(os.path.join(fe_public, 'wails.png'), 'PNG')

    print(f'Applied icon {opt_name} successfully across all targets!')
    return True

if __name__ == '__main__':
    target = sys.argv[1] if len(sys.argv) > 1 else 'opt1_minimal_dark'
    apply_icon(target)
