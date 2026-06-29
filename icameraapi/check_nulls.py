import os

# 要扫描的目录（当前目录）
BASE_DIR = "."

def find_null_bytes(directory):
    print("开始扫描藏有空字节的坏文件...")
    bad_files = []
    for root, _, files in os.walk(directory):
        # 排除掉虚拟环境、缓存和 git 目录，加快速度
        if "site-packages" in root or "__pycache__" in root or ".git" in root:
            continue
        
        for file in files:
            if file.endswith('.py'):
                filepath = os.path.join(root, file)
                try:
                    # 用二进制模式读取，寻找 \x00
                    with open(filepath, 'rb') as f:
                        content = f.read()
                        if b'\x00' in content:
                            bad_files.append(filepath)
                except Exception as e:
                    print(f"无法读取文件 {filepath}: {e}")
                    
    if not bad_files:
        print("🎉 恭喜！你的项目代码里没有发现空字节文件！")
    else:
        print("🚨 抓到以下文件包含导致报错的空字节（请用 VS Code 重新以 UTF-8 保存它们）：")
        for bad_file in bad_files:
            print(f" - {bad_file}")

if __name__ == "__main__":
    find_null_bytes(BASE_DIR)