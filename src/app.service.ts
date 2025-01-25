import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import { CACHE_DIR } from './constants';
import { FileRemoval } from './cleanup/removalUtils';
import * as kill from 'tree-kill';

export interface Job {
  id: string;
  status: 'queued' | 'optimizing' | 'pending downloads limit' | 'completed' | 'failed' | 'cancelled' | 'ready-for-removal';
  progress: number;
  outputPath: string;
  inputUrl: string;
  deviceId: string;
  itemId: string;
  timestamp: Date;
  size: number;
  item: any;
  speed?: number;
}

@Injectable()
export class AppService {
  private activeJobs: Job[] = [];
  private optimizationHistory: Job[] = [];
  private ffmpegProcesses: Map<string, ChildProcess> = new Map();
  private videoDurations: Map<string, number> = new Map();
  private jobQueue: string[] = [];
  private maxConcurrentJobs: number;
  private maxCachedPerUser: number;
  private cacheDir: string;
  private immediateRemoval: boolean;
  private forceAllDownloadsToH265: boolean;
  private maxBitrate: number;
  
  constructor(
    private logger: Logger,
    private configService: ConfigService,
    private readonly fileRemoval: FileRemoval

  ) {
    this.cacheDir = CACHE_DIR;
    this.maxConcurrentJobs = this.configService.get<number>(
      'MAX_CONCURRENT_JOBS',
      1,
    );
    this.maxCachedPerUser = this.configService.get<number>(
      'MAX_CACHED_PER_USER',
      10,
    );
    this.maxBitrate = this.configService.get<number>(
      'MAX_BITRATE',
      0,
    );
    this.immediateRemoval = this.configService.get<string>('REMOVE_FILE_AFTER_RIGHT_DOWNLOAD', 'false').toLowerCase() === 'true';

    this.forceAllDownloadsToH265 = this.configService.get<string>('FORCE_ALL_DOWNLOADS_TO_H265', 'false').toLowerCase() === 'true';
  }

  urlEditor(url: string):string{
    if (this.forceAllDownloadsToH265 === true){
      url = url
      .replace(/VideoCodec=h264/g, "VideoCodec=h265")
    }
    if (this.maxBitrate !== 0){
      url = url
      .replace(/VideoBitrate=\d+/g, `VideoBitrate=${this.maxBitrate}`);
    }
    this.logger.error(url)
    return url
  }

  async downloadAndCombine(
    url: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    fileExtension: string,
    deviceId: string,
    itemId: string,
    item: any,
  ): Promise<string> {
    const jobId = uuidv4();
    const outputPath = path.join(this.cacheDir, `combined_${jobId}.mp4`);
    this.logger.log(
      `Queueing job ${jobId.padEnd(36)} | URL: ${(url.slice(0, 50) + '...').padEnd(53)} | Path: ${outputPath}`,
    );
    url = this.urlEditor(url)

    this.activeJobs.push({
      id: jobId,
      status: 'queued',
      progress: 0,
      outputPath,
      inputUrl: url,
      itemId,
      item,
      deviceId,
      timestamp: new Date(),
      size: 0,
    });

    this.jobQueue.push(jobId);
    this.checkQueue(); // Check if we can start the job immediately

    return jobId;
  }

  getJobStatus(jobId: string): Job | null {
    const job = this.activeJobs.find((job) => job.id === jobId);
    return job || null;
  }

  getAllJobs(deviceId?: string | null): Job[] {
    if (!deviceId) {
      return this.activeJobs;
    }
    return this.activeJobs.filter((job) => job.deviceId === deviceId && job.status !== 'ready-for-removal');
  }

  async deleteCache(): Promise<{ message: string }> {
    try {
      const files = await fsPromises.readdir(this.cacheDir);
      await Promise.all(
        files.map((file) => fsPromises.unlink(path.join(this.cacheDir, file))),
      );
      return {
        message: 'Cache deleted successfully',
      };
    } catch (error) {
      this.logger.error('Error deleting cache:', error);
      throw new InternalServerErrorException('Failed to delete cache');
    }
  }

  removeJob(jobId: string): void {
    this.activeJobs = this.activeJobs.filter(job => job.id !== jobId);
    this.logger.log(`Job ${jobId} removed.`);
  }

  cancelJob(jobId: string): boolean {
    this.completeJob(jobId);
    const job = this.activeJobs.find(job => job.id === jobId);
    const process = this.ffmpegProcesses.get(jobId);
  
    const finalizeJobRemoval = () => {
      if (job) {
        this.jobQueue = this.jobQueue.filter(id => id !== jobId);
        if (this.immediateRemoval === true || job.progress < 100) {
          this.fileRemoval.cleanupReadyForRemovalJobs([job]);
          this.activeJobs = this.activeJobs.filter(activeJob => activeJob.id !== jobId);
          this.logger.log(`Job ${jobId} removed`);
        }
        else{
          this.logger.log('Immediate removal is not allowed, cleanup service will take care in due time')
        }
      }
      this.activeJobs
        .filter((nextjob) => nextjob.deviceId === job.deviceId && nextjob.status === 'pending downloads limit')
        .forEach((job) => job.status = 'queued')
      this.checkQueue();
    };

    if (process) {
      try {
        this.logger.log(`Attempting to kill process tree for PID ${process.pid}`);
        new Promise<void>((resolve, reject) => {
          kill(process.pid, 'SIGINT', (err) => {
            if (err) {
              this.logger.error(`Failed to kill process tree for PID ${process.pid}: ${err.message}`);
              reject(err);
            } else {
              this.logger.log(`Successfully killed process tree for PID ${process.pid}`);
              resolve();
              finalizeJobRemoval()
            }
          });
        });
      } catch (err) { 
        this.logger.error(`Error terminating process for job ${jobId}: ${err.message}`);
      }
      this.ffmpegProcesses.delete(jobId);
      return true;
    } else {
      finalizeJobRemoval();
      return true;
    }
  }
  
  completeJob(jobId: string):void{
    const job = this.activeJobs.find((job) => job.id === jobId);

    if (job) {
      job.status = 'ready-for-removal';
      job.timestamp = new Date()
      this.logger.log(`Job ${jobId} marked as completed and ready for removal.`);
    } else {
      this.logger.warn(`Job ${jobId} not found. Cannot mark as completed.`);
    }
  }

  cleanupJob(jobId: string): void {
    const job = this.activeJobs.find((job) => job.id === jobId);
    this.activeJobs = this.activeJobs.filter((job) => job.id !== jobId);
    this.ffmpegProcesses.delete(jobId);
    this.videoDurations.delete(jobId);
  }

  getTranscodedFilePath(jobId: string): string | null {
    const job = this.activeJobs.find((job) => job.id === jobId);
    if (job && job.status === 'completed') {
      return job.outputPath;
    }
    return null;
  }

  getMaxConcurrentJobs(): number {
    return this.maxConcurrentJobs;
  }

  async getStatistics() {
    const cacheSize = await this.getCacheSize();
    const totalTranscodes = this.getTotalTranscodes();
    const activeJobs = this.getActiveJobs();
    const completedJobs = this.getCompletedJobs();
    const uniqueDevices = this.getUniqueDevices();

    return {
      cacheSize,
      totalTranscodes,
      activeJobs,
      completedJobs,
      uniqueDevices,
    };
  }

  async manuallyStartJob(jobId: string): Promise<boolean> {
    const job = this.activeJobs.find((job) => job.id === jobId);

    if (!job || job.status !== 'queued') {
      return false;
    }

    this.startJob(jobId);
    return true;
  }

  private async getCacheSize(): Promise<string> {
    const cacheSize = await this.getDirectorySize(this.cacheDir);
    return this.formatSize(cacheSize);
  }

  private async getDirectorySize(directory: string): Promise<number> {
    const files = await fs.promises.readdir(directory);
    const stats = await Promise.all(
      files.map((file) => fs.promises.stat(path.join(directory, file))),
    );

    return stats.reduce((accumulator, { size }) => accumulator + size, 0);
  }

  private formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  private getTotalTranscodes(): number {
    return this.activeJobs.length;
  }

  private getActiveJobs(): number {
    return this.activeJobs.filter((job) => job.status === 'optimizing').length;
  }

  private getCompletedJobs(): number {
    return this.activeJobs.filter((job) => job.status === 'ready-for-removal').length;
  }

  private isDeviceIdInOptimizeHistory(job:Job){
    const uniqueDeviceIds: string[] = [...new Set(this.optimizationHistory.map((job: Job) => job.deviceId))];
    const result = uniqueDeviceIds.includes(job.deviceId); // Check if job.deviceId is in uniqueDeviceIds
    this.logger.log(`Device ID ${job.deviceId} is ${result ? 'in' : 'not in'} the finished jobs. Optimizing ${result ? 'Allowed' : 'not Allowed'}`);
    return result
  }

  private getActiveJobDeviceIds(): string[]{
    const uniqueDeviceIds: string[] = [
      ...new Set(
        this.activeJobs
          .filter((job: Job) => job.status === 'queued') // Filter jobs with status 'queued'
          .map((job: Job) => job.deviceId) // Extract deviceId
      )
    ];
    return uniqueDeviceIds
  }
  
  private handleOptimizationHistory(job: Job): void{
    // create a finished jobs list to make sure every device gets equal optimizing time
    this.optimizationHistory.push(job) // push the newest job to the finished jobs list
    const amountOfActiveDeviceIds = this.getActiveJobDeviceIds().length // get the amount of active queued job device ids
    while(amountOfActiveDeviceIds <= this.optimizationHistory.length && this.optimizationHistory.length > 0){ // the finished jobs should always be lower than the amount of active jobs. This is to push out the last deviceid: FIFO
      this.optimizationHistory.shift() // shift away the oldest job.
    }
    this.logger.log(`${this.optimizationHistory.length} deviceIDs have recently finished a job`)
  }

  private getUniqueDevices(): number {
    const devices = new Set(this.activeJobs.map((job) => job.deviceId));
    return devices.size;
  }

  private checkQueue() {
    let runningJobs = this.activeJobs.filter((job) => job.status === 'optimizing').length;
  
    this.logger.log(
      `${runningJobs} active jobs running and ${this.jobQueue.length} items in the queue`,
    );
  
    for (const index in this.jobQueue) {
      if (runningJobs >= this.maxConcurrentJobs) {
        break; // Stop if max concurrent jobs are reached
      }
      const nextJobId = this.jobQueue[index]; // Access job ID by index
      let nextJob: Job = this.activeJobs.find((job) => job.id === nextJobId);
      
      if (!this.userTooManyCachedItems(nextJobId) ) {
        nextJob.status = 'pending downloads limit'
        // Skip this job if user cache limits are reached
        continue;
      }
      if(this.isDeviceIdInOptimizeHistory(nextJob)){
        // Skip this job if deviceID is in the recently finished jobs
        continue
      }
      // Start the job and remove it from the queue
      this.startJob(nextJobId);
      this.jobQueue.splice(Number(index), 1); // Remove the started job from the queue
      runningJobs++; // Increment running jobs
    }
  }

  private userTooManyCachedItems(jobid): boolean{
    if(this.maxCachedPerUser == 0){
      return false
    }
    const theNewJob: Job = this.activeJobs.find((job) => job.id === jobid)
    let completedUserJobs = this.activeJobs.filter((job) => (job.status === "completed" || job.status === 'optimizing') && job.deviceId === theNewJob.deviceId)
    if((completedUserJobs.length >= this.maxCachedPerUser)){
      this.logger.log(`Waiting for items to be downloaded - device ${theNewJob.deviceId} has ${completedUserJobs.length} downloads waiting `);
      return false
    }
    else{
      this.logger.log(`Optimizing - device ${theNewJob.deviceId} has ${completedUserJobs.length} downloads waiting`);
      return true
    }  
  }

  private startJob(jobId: string) {
    const job = this.activeJobs.find((job) => job.id === jobId);
    if (job) {
      job.status = 'optimizing';
      this.handleOptimizationHistory(job)
      const ffmpegArgs = this.getFfmpegArgs(job.inputUrl, job.outputPath);
      this.startFFmpegProcess(jobId, ffmpegArgs)
        .finally(() => {
          // This runs after the returned Promise resolves or rejects.
          this.checkQueue();
        });
      this.logger.log(`Started job ${jobId}`);
    }
  }

  private getFfmpegArgs(inputUrl: string, outputPath: string): string[] {
    return [
      '-i',
      inputUrl,
      '-c',
      'copy', // Copy both video and audio without re-encoding
      '-movflags',
      '+faststart', // Optimize for web streaming
      '-f',
      'mp4', // Force MP4 container
      outputPath,
    ];
  }

  
  private async startFFmpegProcess(
    jobId: string,
    ffmpegArgs: string[],
  ): Promise<void> {
    try {
      await this.getVideoDuration(ffmpegArgs[1], jobId);

      return new Promise((resolve, reject) => {
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe']});
        this.ffmpegProcesses.set(jobId, ffmpegProcess);

        ffmpegProcess.stderr.on('data', (data) => {
          this.updateProgress(jobId, data.toString());
        });
        
        ffmpegProcess.on('close', async (code) => {
          this.ffmpegProcesses.delete(jobId);
          this.videoDurations.delete(jobId);

          const job = this.activeJobs.find((job) => job.id === jobId);
          if (!job) {
            resolve();
            return;
          }

          if (code === 0) {
            job.status = 'completed';
            job.progress = 100;
            // Update the file size
            try {
              const stats = await fsPromises.stat(job.outputPath);
              job.size = stats.size;
            } catch (error) {
              this.logger.error(
                `Error getting file size for job ${jobId}: ${error.message}`,
              );
            }
            this.logger.log(
              `Job ${jobId} completed successfully. Output: ${job.outputPath}, Size: ${this.formatSize(job.size || 0)}`,
            );
            resolve();
          } else {
            job.status = 'failed';
            job.progress = 0;
            this.logger.error(
              `Job ${jobId} failed with exit code ${code}. Input URL: ${job.inputUrl}`,
            );
            // reject(new Error(`FFmpeg process failed with exit code ${code}`));
          }
        });

        ffmpegProcess.on('error', (error) => {
          this.logger.error(
            `FFmpeg process error for job ${jobId}: ${error.message}`,
          );
          // reject(error);
        });
      });
    } catch (error) {
      this.logger.error(`Error processing job ${jobId}: ${error.message}`);
      const job = this.activeJobs.find((job) => job.id === jobId);
      if (job) {
        job.status = 'failed';
      }
    }
  }


  private async getVideoDuration(
    inputUrl: string,
    jobId: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        inputUrl,
      ]);

      let output = '';

      ffprobe.stdout.on('data', (data) => {
        output += data.toString();
      });

      ffprobe.on('close', (code) => {
        if (code === 0) {
          const duration = parseFloat(output.trim());
          this.videoDurations.set(jobId, duration);
          resolve();
        } else {
          reject(new Error(`ffprobe process exited with code ${code}`));
        }
      });
    });
  }

  private updateProgress(jobId: string, ffmpegOutput: string): void {
    const progressMatch = ffmpegOutput.match(
      /time=(\d{2}):(\d{2}):(\d{2})\.\d{2}/,
    );
    const speedMatch = ffmpegOutput.match(/speed=(\d+\.?\d*)x/);

    if (progressMatch) {
      const [, hours, minutes, seconds] = progressMatch;
      const currentTime =
        parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseInt(seconds);

      const totalDuration = this.videoDurations.get(jobId);
      if (totalDuration) {
        const progress = Math.min((currentTime / totalDuration) * 100, 99.9);
        const job = this.activeJobs.find((job) => job.id === jobId);
        if (job) {
          job.progress = Math.max(progress, 0);

          // Update speed if available
          if (speedMatch) {
            const speed = parseFloat(speedMatch[1]);
            job.speed = Math.max(speed, 0);
          }
        }
      }
    }
  }
}
