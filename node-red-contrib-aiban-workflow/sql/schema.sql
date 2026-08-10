-- AiBan Workflow 2.0 — standard terminal result store (T17)
-- Usage: mysql -u root -p < sql/schema.sql

CREATE DATABASE IF NOT EXISTS icamera_data
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS icamera_data.workflow_result_event (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    result_event_id VARCHAR(512) NOT NULL COMMENT '标准结果幂等键',
    workflow_id VARCHAR(191) NOT NULL,
    scene_id VARCHAR(191) NOT NULL,
    cycle_id VARCHAR(64) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    stream_id VARCHAR(191) NOT NULL,
    group_id INT NOT NULL,
    source_id INT NOT NULL,
    result_status ENUM('OK','NG','TIMEOUT','INTERRUPTED') NOT NULL,
    failure_reason TEXT NULL,
    image_path VARCHAR(1024) NOT NULL DEFAULT '',
    started_at VARCHAR(40) NULL,
    finished_at VARCHAR(40) NOT NULL,
    duration_ms DOUBLE NULL,
    result_json JSON NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_workflow_result_event (result_event_id),
    KEY idx_workflow_scene_cycle (workflow_id, scene_id, cycle_id),
    KEY idx_stream_status_finished (stream_id, result_status, finished_at),
    KEY idx_group_source_finished (group_id, source_id, finished_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Workflow 2.0 standard terminal outcomes';
