import os
import subprocess
from multiprocessing import Pool
import shutil
import datetime
from flask import make_response, request, Blueprint
from icamera.common.mysql_operate import db

#blueprin
playback_blueprint = Blueprint('playback', __name__,template_folder='templates')

class VideoMerger:
    """
    视频合并工具类
    """
    @staticmethod
    def get_video_files(folder_path):
        """
        获取文件夹内的所有视频文件
        :param folder_path: 文件夹路径
        :return: 视频文件路径列表
        """
        # 支持的视频格式
        video_extensions = [".mp4", ".mkv", ".avi", ".mov", ".flv", ".wmv"]

        # 获取文件夹内的所有视频文件
        video_files = [
            os.path.join(folder_path, f) for f in os.listdir(folder_path)
            if os.path.splitext(f)[1].lower() in video_extensions
        ]

        # 按文件名排序
        video_files.sort()

        return video_files

    @staticmethod
    def merge_videos_ffmpeg(video_files, output_file, list_file=None):
        """
        使用 FFmpeg 合并视频
        :param video_files: 视频文件路径列表
        :param output_file: 输出文件路径
        :param list_file: 临时文件列表路径（可选）
        """
        try:
            # 生成 FFmpeg 输入文件列表
            if not list_file:
                list_file = "file_list.txt"
            with open(list_file, "w") as f:
                for video in video_files:
                    f.write(f"file '{video}'\n")

            # 调用 FFmpeg 合并视频
            command = [
                "ffmpeg",
                "-f", "concat",  # 指定输入格式为文件列表
                "-safe", "0",  # 允许使用绝对路径
                "-i", list_file,  # 输入文件列表
                "-c", "copy",  # 直接复制视频流，不重新编码
                "-vsync", "vfr",  # 修复时间戳问题
                "-async", "1",  # 修复音频同步问题
                output_file  # 输出文件
            ]
            subprocess.run(command, check=True)

            print(f"视频合并完成，已保存到: {output_file}")
        except Exception as e:
            print(f"视频合并失败: {e}")
        finally:
            # 删除临时文件
            if list_file and os.path.exists(list_file):
                os.remove(list_file)

class ChunkMerger:
    """
    分块合并工具类
    """
    def __init__(self, folder_path, output_file, chunk_size=100, num_processes=13):
        """
        初始化
        :param folder_path: 文件夹路径
        :param output_file: 输出文件路径
        :param chunk_size: 每块视频的数量
        :param num_processes: 并行进程数量
        """
        self.folder_path = folder_path
        self.output_file = output_file
        self.chunk_size = chunk_size
        self.num_processes = num_processes
        self.temp_dir = os.path.join(folder_path, "temp_chunks")  # 临时目录路径

    def merge_chunks(self):
        """
        分块合并视频
        """
        try:
            # 获取文件夹内的所有视频文件
            video_files = VideoMerger.get_video_files(self.folder_path)

            if not video_files:
                print(f"文件夹 {self.folder_path} 中没有视频文件！")
                return

            # 创建临时目录
            os.makedirs(self.temp_dir, exist_ok=True)

            # 分块处理视频
            chunks = [video_files[i:i + self.chunk_size] for i in range(0, len(video_files), self.chunk_size)]
            chunk_outputs = [os.path.join(self.temp_dir, f"temp_chunk_{i}.mp4") for i in range(len(chunks))]
            list_files = [os.path.join(self.temp_dir, f"file_list_{i}.txt") for i in range(len(chunks))]

            # 使用进程池并行处理
            with Pool(processes=self.num_processes) as pool:
                pool.starmap(self.merge_chunk, zip(chunks, chunk_outputs, list_files))

            # 检查临时块文件是否存在
            for chunk_output in chunk_outputs:
                if not os.path.exists(chunk_output):
                    raise FileNotFoundError(f"临时块文件 {chunk_output} 不存在！")

            # 合并所有块
            VideoMerger.merge_videos_ffmpeg(chunk_outputs, self.output_file)

            print(f"所有视频合并完成，已保存到: {self.output_file}")
        except Exception as e:
            print(f"分块合并失败: {e}")
        finally:
            # 删除临时目录及其内容
            if os.path.exists(self.temp_dir):
                shutil.rmtree(self.temp_dir)

    @staticmethod
    def merge_chunk(chunk, chunk_output, list_file):
        """
        合并一个视频块
        :param chunk: 视频文件路径列表
        :param chunk_output: 输出文件路径
        :param list_file: 临时文件列表路径
        """
        VideoMerger.merge_videos_ffmpeg(chunk, chunk_output, list_file)

@playback_blueprint.route('/camera_api/iot/camera/get-playback', methods=['POST'])
def real_playback():
    time = str(request.json.get('time'))
    id = str(request.json.get('cameraid'))

    if id in ['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','20','21','22']:
        groupid = '1'
    if id in ['16']:
        groupid = '2'
    if id in ['18']:
        groupid = '3'
    if id in ['19']:
        groupid = '4'
    if id in ['17']:
        groupid = '5'

    file = "/ngvideo/video/" + id + "/" + time + '.mp4'

    res = {
        "success": False,
        "code": 47,
        "msg": "in",
        "data": True,
        "file": file
    }
    return make_response(res)