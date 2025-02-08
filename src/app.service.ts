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
  private ApiKey: string;
  private extension: string = 'matroska'
  
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

    this.ApiKey = this.configService.get<string>(
      'JELLYFIN_API_KEY',
    );
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
    const outputPath = path.join(this.cacheDir, `combined_${jobId}.mkv`);
    this.logger.log(
      `Queueing job ${jobId.padEnd(36)} | URL: ${(url.slice(0, 50) + '...').padEnd(53)} | Path: ${outputPath}`,
    );

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

  private async startJob(jobId: string) { // Add "async" to the function
    const job = this.activeJobs.find((job) => job.id === jobId);
    if (job) {
        job.status = 'optimizing';
        this.handleOptimizationHistory(job);

        try {
            // Await the Promise to ensure subtitles are loaded before FFmpeg starts
            const ffmpegArgs = await this.getFfmpegArgs(job.inputUrl, job.itemId, job.outputPath);
            // this.logger.log(ffmpegArgs)
            // Now FFmpeg will start with the correct arguments
            await this.startFFmpegProcess(jobId, ffmpegArgs)
            .finally(() => {this.checkQueue()});

        } catch (error) {
            this.logger.error(`Error processing job ${jobId}:`, error);
        }
        this.logger.log(`Started job ${jobId}`);
    }
  }

  private async getFfmpegArgs(
    inputUrl: string,
    mediaSourceId: string,
    outputPath: string
  ): Promise<string[]> {
    // Get available subtitles and log them
    const subtitleStreams = await this.getAvailableSubtitles(mediaSourceId);
    // this.logger.log(subtitleStreams);
  
    // Start with the main video input
    const ffmpegArgs: string[] = ['-i', inputUrl];
  
    // Collect valid subtitle inputs and add each as an input
    const validSubs: { path: string; language: string }[] = [];
    for (const sub of subtitleStreams) {
      const localSubtitlePath = await this.fetchLocalSubtitle(mediaSourceId, sub.filePath);
      if (!localSubtitlePath) {
        this.logger.warn(`Skipping missing subtitle: ${sub.filePath}`);
        continue;
      }
      validSubs.push({ path: localSubtitlePath, language: sub.language || 'und' });
      ffmpegArgs.push('-i', localSubtitlePath);
    }
  
    // Map main video and audio from input 0 (ignores missing streams)
    ffmpegArgs.push('-map', '0:v?', '-map', '0:a?');
  
    // Map each subtitle input (they become inputs 1, 2, …)
    validSubs.forEach((sub, index) => {
      // Map first stream from each subtitle file
      ffmpegArgs.push('-map', `${index + 1}:0`);
      ffmpegArgs.push('-metadata:s:s:' + index, `language=${sub.language}`);
    });
  
    // Set codecs to copy streams directly (no re-encoding)
    ffmpegArgs.push('-c:v', 'copy', '-c:a', 'copy');
    if (validSubs.length > 0) {
      ffmpegArgs.push('-c:s', 'copy');
    }
  
    // Set output container to MKV (removing the unnecessary movflags for MP4)
    ffmpegArgs.push('-f', this.extension, outputPath);
    return ffmpegArgs;
  }
  

  private async getAvailableSubtitles(mediaSourceId: string): Promise<{ index: number, language: string, filePath: string }[]> {
    const subtitlesApiUrl = `https://jellyfin.geraldserver.nl/Items/${mediaSourceId}/PlaybackInfo?api_key=${this.ApiKey}`;
    this.logger.log(`Fetching subtitles from: ${subtitlesApiUrl}`);

    try {
        const response = await fetch(subtitlesApiUrl);
        const data = await response.json();

        if (!data.MediaSources || data.MediaSources.length === 0) {
            throw new Error("No media sources found.");
        }

        const mediaSource = data.MediaSources[0];

        return (mediaSource?.MediaStreams || [])
            .filter((stream: any) => stream.Type === "Subtitle") // Only subtitles
            .map((stream: any) => ({
                index: stream.Index,
                language: stream.Language || 'und',
                filePath: stream.Path, // Return the real subtitle file path
            }));
    } catch (error) {
        console.error('Error fetching subtitles:', error);
        return [];
    }
  }

  private async fetchLocalSubtitle(mediaSourceId: string, subtitlePath: string): Promise<string> {
    // Construct the local destination path
    // subtitlePath = path.join('//192.168.1.120', subtitlePath);

    const localPath = path.join(__dirname, `../cache/${mediaSourceId}_${path.basename(subtitlePath)}`);

    try {
        // Ensure the source subtitle file exists
        if (!fs.existsSync(subtitlePath)) {
            throw new Error(`Subtitle file not found: ${subtitlePath}`);
        }

        // Copy the subtitle file to the cache location
        fs.copyFileSync(subtitlePath, localPath);
        this.logger.log(`Subtitle copied to: ${localPath}`);

        return localPath; // Return the new local path
    } catch (error) {
        console.error(`Error copying subtitle: ${subtitlePath}`, error);
        return ""; // Return empty string if failed
    }
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
