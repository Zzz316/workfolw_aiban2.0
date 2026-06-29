import os
import shutil
from datetime import datetime

# 尝试导入 moviepy，如果失败则设置标志
try:
    from moviepy import VideoFileClip, concatenate_videoclips
    MOVIEPY_AVAILABLE = True
except ImportError:
    MOVIEPY_AVAILABLE = False
    print("警告: 未安装 moviepy 模块，视频合并功能将不可用")

def parse_filename(filename):
    """解析文件名，返回 (datetime对象, 文件路径)"""
    if filename.startswith(".") or not filename.endswith(".mp4"):
        raise ValueError(f"无效文件: {filename}")

    name = filename.split(".")[0]  # 去掉 .mp4
    parts = name.split("-")
    if len(parts) < 4:
        raise ValueError(f"文件名格式错误: {filename} (应为 HH-MM-SS-序号.mp4)")

    hour, minute, second, seq = parts[:4]
    file_time = datetime.strptime(f"{hour}:{minute}:{second}", "%H:%M:%S")
    return file_time, filename

def find_and_sort_videos(target_time_str, folder_path, output_dir, tolerance=1.5, reverse=False):
    """
    查找目标时间附近的视频，排序并复制到指定目录
    :param target_time_str: 目标时间，如 "15:28:30"
    :param folder_path: 视频文件夹路径
    :param output_dir: 输出目录路径
    :param tolerance: 时间容忍度（分钟）
    :param reverse: 是否降序排序
    """
    target_time = datetime.strptime(target_time_str, "%H:%M:%S")
    matched_files = []

    # 确保输出目录存在
    os.makedirs(output_dir, exist_ok=True)

    for filename in os.listdir(folder_path):
        try:
            file_time, filename = parse_filename(filename)
        except ValueError as e:
            print(f"跳过文件 {filename}: {e}")
            continue

        # 检查时间是否在允许范围内
        if abs((file_time - target_time).total_seconds()) <= tolerance * 60:
            matched_files.append((file_time, filename))

    # 按时间排序
    matched_files.sort(reverse=reverse)

    # 复制文件到输出目录
    copied_files = []
    for file_time, filename in matched_files:
        src_path = os.path.join(folder_path, filename)
        dst_path = os.path.join(output_dir, filename)
        shutil.copy2(src_path, dst_path)
        copied_files.append(dst_path)
        print(f"已复制: {filename} -> {dst_path}")

    print(f"\n共复制 {len(copied_files)} 个文件到 {output_dir}")
    return copied_files

def merge_and_clean(video_paths, output_path):
    """
    合并视频并删除原始文件

    Args:
        video_paths: 要合并的视频路径列表（3个视频）
        output_path: 合并后的输出路径

    Returns:
        str: 合并后的视频绝对路径
    """
    # 检查 moviepy 是否可用
    if not MOVIEPY_AVAILABLE:
        raise ImportError("moviepy 模块未安装，无法执行视频合并操作")

    # 检查文件是否存在
    for path in video_paths:
        if not os.path.exists(path):
            raise FileNotFoundError(f"视频文件不存在: {path}")

    # 加载所有视频片段
    clips = [VideoFileClip(path) for path in video_paths]

    # 合并视频
    final_clip = concatenate_videoclips(clips)

    # 写入合并后的视频
    final_clip.write_videofile(
        output_path,
        codec='h264_nvenc',  # H.264编码
        fps=15,
        audio_codec='aac',  # AAC音频编码
        temp_audiofile='temp-audio.m4a',
        remove_temp=True
    )

    # 关闭所有片段释放资源
    for clip in clips:
        clip.close()
    final_clip.close()

    # 删除原始视频文件
    for path in video_paths:
        try:
            os.remove(path)
            print(f"已删除原始文件: {path}")
        except Exception as e:
            print(f"删除文件 {path} 失败: {str(e)}")

    # 返回合并后的文件绝对路径
    return os.path.abspath(output_path)


