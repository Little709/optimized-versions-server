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
  private ApiKey: string;
  private jellyfinURL: string
  
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
    this.immediateRemoval = this.configService.get<string>('REMOVE_FILE_AFTER_RIGHT_DOWNLOAD', 'false').toLowerCase() === 'true';

    this.ApiKey = this.configService.get<string>(
      'JELLYFIN_API_KEY',
    );
    this.jellyfinURL = this.configService.get<string>(
      'JELLYFIN_URL',
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
            await this.getVideoDuration(job.inputUrl, jobId);
            // Await the Promise to ensure subtitles are loaded before FFmpeg starts
            const ffmpegArgs = await this.getFfmpegArgs(job.inputUrl, job.itemId, job.outputPath,this.videoDurations.get(jobId));
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
    outputPath: string,
    videoDuration: number
  ): Promise<string[]> {
    const ffmpegArgs: string[] = [];
    ffmpegArgs.push('-i', inputUrl);
  
    // 1. Get all subtitle streams
    const allSubStreams = await this.getAvailableSubtitles(mediaSourceId);
  
    // 2. Check if any internal subtitles exist (isExternal === false)
    const hasInternalSubs = allSubStreams.some(sub => !sub.isExternal);
  
    let internalSubsIndex = -1;
    if (hasInternalSubs) {
      // Only fetch the original file path if internal subs are available
      const subtitlesApiUrl = `${this.jellyfinURL}/Items/${mediaSourceId}/PlaybackInfo?api_key=${this.ApiKey}`;
      let originalFilePath: string | null = null;
      try {
        const resp = await fetch(subtitlesApiUrl);
        const data = await resp.json();
        const mediaSource = data.MediaSources?.[0];
        if (mediaSource?.Path) {
          this.logger.error(mediaSource.Path);
          originalFilePath = mediaSource.Path;
        }
      } catch (err) {
        this.logger.warn(`Could not fetch original file for ID ${mediaSourceId}: ${err}`);
      }
      if (originalFilePath) {
        ffmpegArgs.push('-i', originalFilePath);
        internalSubsIndex = 1;
      }
    }
  
    // 3. Process external subtitles (isExternal === true)
    const externalSubs: { path: string; language: string }[] = [];
    for (const sub of allSubStreams) {
      if (!sub.isExternal) continue;
      const localSubtitlePath = await this.fetchLocalSubtitle(mediaSourceId, sub.filePath, videoDuration);
      if (!localSubtitlePath) {
        this.logger.warn(`Skipping missing external subtitle: ${sub.filePath}`);
        continue;
      }
      externalSubs.push({ path: localSubtitlePath, language: sub.language || 'und' });
    }
  
    // 4. Map video and audio from the HLS input (#0)
    ffmpegArgs.push('-map', '0:v?', '-map', '0:a?');
  
    // 5. Map internal subtitles if we added the original file input
    if (internalSubsIndex >= 0) {
      ffmpegArgs.push('-map', `${internalSubsIndex}:s?`);
    }
  
    // 6. Map external subtitles
    //    If internal subs exist, external inputs start at index 2; otherwise at index 1
    const firstExtIndex = internalSubsIndex >= 0 ? 2 : 1;
    externalSubs.forEach(({ language }, i) => {
      ffmpegArgs.push('-map', `${firstExtIndex + i}:0`);
      ffmpegArgs.push(`-metadata:s:s:${i}`, `language=${language}`);
    });
  
    // 7. Copy streams without re-encoding and set final container
    ffmpegArgs.push('-c:v', 'copy', '-c:a', 'copy', '-c:s', 'copy');
    ffmpegArgs.push('-f', "matroska", outputPath);
  
    this.logger.debug(ffmpegArgs);
    return ffmpegArgs;
  }
  
    
  private async getAvailableSubtitles(
    mediaSourceId: string
  ): Promise<Array<{ 
    index: number;
    language: string;
    filePath?: string;    // might be undefined for internal subs
    isExternal: boolean;
  }>> {
    const subtitlesApiUrl = `${this.jellyfinURL}/Items/${mediaSourceId}/PlaybackInfo?api_key=${this.ApiKey}`;
    this.logger.log(`Fetching subtitles from: ${subtitlesApiUrl}`);
  
    try {
      const response = await fetch(subtitlesApiUrl);
      const data = await response.json();
      // this.logger.debug(data)
      if (!data.MediaSources || data.MediaSources.length === 0) {
        throw new Error("No media sources found.");
      }
  
      const mediaSource = data.MediaSources[0];
  
      // Now we filter only by Type === "Subtitle", no longer ignoring .IsExternal
      const allSubtitleStreams = (mediaSource?.MediaStreams || [])
      .filter((stream: any) => stream.Type === "Subtitle")
      .map((stream: any) => {
        const isExternal = !!stream.IsExternal;
        return {
          index: stream.Index,
          language: stream.Language || 'und',
          // For external subs, use the subtitle's own Path
          // For internal subs, use the MediaSource's overall file path
          filePath: isExternal ? stream.Path : mediaSource.Path,
          isExternal
        };
      });
  
      return allSubtitleStreams;
    } catch (error) {
      this.logger.error('Error fetching subtitles:', error);
      return [];
    }
  }

  private async fetchLocalSubtitle(
    mediaSourceId: string,
    subtitlePath: string,
    videoDuration: number
  ): Promise<string> {
    // Construct local path (replace any network path logic as needed)
    const localPath = path.join(__dirname, `../cache/${mediaSourceId}_${path.basename(subtitlePath)}`);
  
    try {
      if (!fs.existsSync(subtitlePath)) {
        throw new Error(`Subtitle file not found: ${subtitlePath}`);
      }
  
      // Read the existing SRT file
      let subtitleContent = fs.readFileSync(subtitlePath, 'utf8');
  
      // Get last subtitle index
      const lastIndex = this.getLastSubtitleIndex(subtitleContent);
  
      // Get the last subtitle timestamp
      const lastTimestamp = this.getLastSubtitleTimestamp(subtitleContent);
  
      // If there's no trailing newline, add one
      if (!subtitleContent.endsWith('\n')) {
        subtitleContent += '\n';
      }
  
      // If subtitles end too soon, add a blank subtitle at the end
      if (lastTimestamp < videoDuration - 2) {
        const blankSubtitleIndex = lastIndex + 1;
        const startTime = this.formatSrtTimestamp(videoDuration - 1);
        const endTime   = this.formatSrtTimestamp(videoDuration);
        // Append a new subtitle block using the next index
        subtitleContent += `\n${blankSubtitleIndex}\n${startTime} --> ${endTime}\n.\n`;
      }
  
      // Save the updated subtitle file
      fs.writeFileSync(localPath, subtitleContent, 'utf8');
      this.logger.log(`Subtitle adjusted and saved to: ${localPath}`);
  
      return localPath;
    } catch (error) {
      console.error(`Error modifying subtitle: ${subtitlePath}`, error);
      return '';
    }
  }
  
  // Helper to grab the largest subtitle index in the file
  private getLastSubtitleIndex(srtContent: string): number {
    const lines = srtContent.split('\n');
    let maxIndex = 0;
    for (const line of lines) {
      const num = parseInt(line.trim(), 10);
      if (!isNaN(num) && num > maxIndex) {
        maxIndex = num;
      }
    }
    return maxIndex;
  }
  
  // Helper to find the last timestamp in seconds
  private getLastSubtitleTimestamp(srtContent: string): number {
    const matches = srtContent.match(/(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})/g);
    if (!matches) return 0;
    const lastMatch = matches[matches.length - 1].split(' --> ')[1];
    return this.srtTimestampToSeconds(lastMatch);
  }
  
  // Convert SRT timestamp to total seconds
  private srtTimestampToSeconds(timestamp: string): number {
    // "HH:MM:SS,mmm" -> split by : then convert to float after replacing comma
    const [h, m, s] = timestamp.replace(',', '.').split(':').map(parseFloat);
    return h * 3600 + m * 60 + s;
  }
  
  // Format seconds to SRT "HH:MM:SS,mmm" style
  private formatSrtTimestamp(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = (seconds % 60).toFixed(3).replace('.', ',');
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(6, '0')}`;
  }


  private async startFFmpegProcess(
    jobId: string,
    ffmpegArgs: string[],
  ): Promise<void> {
    try {

      return new Promise((resolve, reject) => {
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe']});
        let ffmpegError = '';
        ffmpegProcess.stderr.on('data', data => {
          ffmpegError += data.toString();
        });
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
              `Job ${jobId} failed with exit code ${code}. Error: ${ffmpegError.trim()}. Input URL: ${job.inputUrl}`
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
