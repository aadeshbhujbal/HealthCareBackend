#!/bin/bash
# Healthcare API Rollback Script
# This script handles rollback operations for the Healthcare API

set -e

# Configuration
DEPLOY_PATH="/var/www/healthcare/backend"
LOG_FILE="/var/log/healthcare/rollback.log"
DEBUG_LOG_FILE="/var/log/healthcare/rollback-debug.log"
BACKUP_DIR="$DEPLOY_PATH/backups"
RELEASES_DIR="$DEPLOY_PATH/releases"
SUCCESSFUL_DEPLOYMENTS_FILE="$DEPLOY_PATH/successful_deployments.txt"
MAX_ROLLBACK_ATTEMPTS=3
HEALTH_CHECK_TIMEOUT=300 # 5 minutes
CONTAINER_STARTUP_TIMEOUT=180 # 3 minutes

# Ensure log directories exist
mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$DEBUG_LOG_FILE")"

# Logging functions
log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log_debug() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] DEBUG: $1" >> "$DEBUG_LOG_FILE"
}

log_error() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1" | tee -a "$LOG_FILE" "$DEBUG_LOG_FILE"
}

# Function to check if a container is healthy
check_container_health() {
    local container_name=$1
    local timeout=$2
    local start_time=$(date +%s)
    local current_time
    
    while true; do
        current_time=$(date +%s)
        if [ $((current_time - start_time)) -gt "$timeout" ]; then
            log_error "Container health check timed out after ${timeout}s"
            return 1
        fi
        
        if docker ps --filter "name=$container_name" --format "{{.Status}}" | grep -q "healthy"; then
            log_message "Container $container_name is healthy"
            return 0
        elif ! docker ps --filter "name=$container_name" | grep -q "$container_name"; then
            log_error "Container $container_name is not running"
            return 1
        fi
        
        sleep 5
    done
}

# Function to verify application health
verify_application_health() {
    local max_attempts=5
    local attempt=1
    local delay=10
    
    while [ $attempt -le $max_attempts ]; do
        log_message "Health check attempt $attempt/$max_attempts..."
        
        # Try multiple health check methods
        for method in "curl" "wget" "nc"; do
            case $method in
                "curl")
                    if curl -s -f http://localhost:8088/health > /dev/null 2>&1; then
                        log_message "Health check passed via curl"
                        return 0
                    fi
                    ;;
                "wget")
                    if wget -q -O - http://localhost:8088/health > /dev/null 2>&1; then
                        log_message "Health check passed via wget"
                        return 0
                    fi
                    ;;
                "nc")
                    if echo -e "GET /health HTTP/1.1\r\nHost: localhost:8088\r\n\r\n" | nc localhost 8088 | grep -q "200 OK"; then
                        log_message "Health check passed via netcat"
                        return 0
                    fi
                    ;;
            esac
        done
        
        log_message "Health check attempt $attempt failed, waiting ${delay}s..."
        sleep $delay
        attempt=$((attempt + 1))
    done
    
    return 1
}

# Function to stop API container
stop_api_container() {
    log_message "Stopping API container..."
    if docker ps -q --filter "name=latest-api" | grep -q .; then
        docker stop latest-api || log_error "Failed to stop API container"
        docker rm latest-api || log_error "Failed to remove API container"
    else
        log_message "No API container found to stop"
    fi
}

# Function to start API container
start_api_container() {
    local deployment_path=$1
    log_message "Starting API container from $deployment_path..."
    
    cd "$deployment_path"
    if [ ! -f "docker-compose.prod.yml" ]; then
        log_error "docker-compose.prod.yml not found in $deployment_path"
        return 1
    fi
    
    docker-compose -f docker-compose.prod.yml up -d --no-deps api
    if ! check_container_health "latest-api" "$CONTAINER_STARTUP_TIMEOUT"; then
        log_error "Failed to start API container"
        return 1
    fi
    
    return 0
}

# Function to perform rollback
perform_rollback() {
    local target_deployment=$1
    local rollback_type=$2
    
    log_message "Performing $rollback_type rollback to: $target_deployment"
    
    # Stop current API
    stop_api_container
    
    # Update symlink
    if ! ln -sfn "$target_deployment" "$DEPLOY_PATH/current"; then
        log_error "Failed to update symlink to $target_deployment"
        return 1
    fi
    
    # Start API from target deployment
    if ! start_api_container "$target_deployment"; then
        log_error "Failed to start API from $target_deployment"
        return 1
    fi
    
    # Verify application health
    if verify_application_health; then
        log_message "✅ Rollback to $target_deployment successful"
        return 0
    else
        log_error "Application health check failed after rollback"
        return 1
    fi
}

# Main rollback logic
main() {
    log_message "========== ROLLBACK PROCESS STARTED =========="
    log_debug "Current directory: $(pwd)"
    log_debug "Current containers: $(docker ps)"
    
    # Check if we're in auto mode
    AUTO_MODE=$1
    
    # Try rollback to last successful deployment first
    if [ -f "$SUCCESSFUL_DEPLOYMENTS_FILE" ]; then
        CURRENT_DEPLOY=$(readlink -f "$DEPLOY_PATH/current" | xargs basename)
        LAST_SUCCESSFUL=$(grep -v "$CURRENT_DEPLOY" "$SUCCESSFUL_DEPLOYMENTS_FILE" | tail -n 1)
        
        if [ -n "$LAST_SUCCESSFUL" ] && [ -d "$RELEASES_DIR/$LAST_SUCCESSFUL" ]; then
            if perform_rollback "$RELEASES_DIR/$LAST_SUCCESSFUL" "last successful deployment"; then
                exit 0
            fi
        else
            log_message "No valid last successful deployment found"
        fi
    fi
    
    # Try rollback to latest backup
    if [ -f "$BACKUP_DIR/latest_backup" ]; then
        BACKUP_ID=$(cat "$BACKUP_DIR/latest_backup")
        if [ -d "$BACKUP_DIR/$BACKUP_ID" ]; then
            # Create a new release from backup
            ROLLBACK_RELEASE="rollback_$(date +%Y%m%d_%H%M%S)"
            mkdir -p "$RELEASES_DIR/$ROLLBACK_RELEASE"
            cp -r "$BACKUP_DIR/$BACKUP_ID/"* "$RELEASES_DIR/$ROLLBACK_RELEASE/"
            
            if perform_rollback "$RELEASES_DIR/$ROLLBACK_RELEASE" "backup"; then
                exit 0
            fi
        fi
    fi
    
    # If we get here, both rollback attempts failed
    log_error "All rollback attempts failed"
    log_debug "Final container status: $(docker ps -a)"
    log_debug "API container logs: $(docker logs latest-api 2>&1 || echo 'No logs available')"
    exit 1
}

# Error handler
error_handler() {
    local line_no=$1
    local error_code=$2
    local command=$3
    log_error "Error occurred in command '$command' at line $line_no (Exit code: $error_code)"
}

# Set up error handling
trap 'error_handler ${LINENO} $? "$BASH_COMMAND"' ERR

# Execute main function
main "$@" 