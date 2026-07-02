-- AiBan Workflow 2.0 — Phase 2: A-B-C Sequential Recognition Result Table
-- Database: icamera_data
-- Usage: mysql -u root -p icamera_data < sql/schema.sql

CREATE TABLE IF NOT EXISTS icamera_data.workflow_abc_result (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    event_id VARCHAR(255) NOT NULL COMMENT '业务幂等键: workflow_id:session_id:stream_id:cycle_id:result_status',
    cycle_id VARCHAR(64) NOT NULL COMMENT '本次A-B-C周期ID (UUID)',
    workflow_id VARCHAR(128) NOT NULL COMMENT '流程ID',
    session_id VARCHAR(64) NOT NULL COMMENT 'SDK会话ID',
    stream_id VARCHAR(128) NOT NULL COMMENT 'group/source流标识, 如 group-1/source-1',
    group_id INT NOT NULL COMMENT '视频组ID',
    source_id INT NOT NULL COMMENT '视频源ID',
    start_frame_seq BIGINT COMMENT '周期起始帧序号',
    end_frame_seq BIGINT COMMENT '周期结束帧序号',
    actual_sequence JSON COMMENT '实际步骤序列, JSON数组如 ["A","B","C"]',
    result_status VARCHAR(16) NOT NULL COMMENT '结果状态: OK | NG | TIMEOUT | INTERRUPTED',
    failure_reason TEXT COMMENT '失败或超时原因',
    started_at VARCHAR(32) COMMENT '周期开始时间 (北京时间 ISO8601)',
    finished_at VARCHAR(32) COMMENT '周期结束时间 (北京时间 ISO8601)',
    cycle_duration_ms DOUBLE COMMENT '业务周期耗时 (ms)',
    db_write_duration_ms DOUBLE COMMENT '实际写库耗时 (ms)',
    created_at VARCHAR(32) NOT NULL COMMENT '数据库记录创建时间 (北京时间 ISO8601)',
    UNIQUE INDEX idx_event_id (event_id),
    INDEX idx_workflow_stream (workflow_id, stream_id, created_at),
    INDEX idx_result_status (result_status, created_at),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='A-B-C顺序识别结果表 (Phase 2)';
