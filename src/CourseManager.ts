import * as vscode from 'vscode';
import { BaseManager } from './BaseManager';

export interface CourseSlide {
    title: string;
    markdown: string;
    narrationScript?: string;
    courseText?: string;
    newTerms?: string[];
}

export interface CourseLesson {
    title: string;
    slides: CourseSlide[];
}

export interface CourseSection {
    title: string;
    lessons: CourseLesson[];
}

export interface CourseSyllabus {
    sections: CourseSection[];
}

export interface Course {
    id: string;
    title: string;
    description: string;
    syllabus: CourseSyllabus;
    backingDossierId?: string;
    vocabularyPlan?: string[];
    generationVersion?: number;
    createdAt: string;
    updatedAt: string;
}

export interface CourseIndex {
    id: string;
    title: string;
    description: string;
    slideCount: number;
    createdAt: string;
}

export class CourseManager extends BaseManager<Course, CourseIndex> {
    protected readonly indexKey = 'thothAlpha.courseIndex';
    protected readonly dirName = 'courses';

    constructor(context: vscode.ExtensionContext) {
        super(context, 'thothAlpha.courseIndex', 'courses');
    }

    protected toIndex(entity: Course): CourseIndex {
        return {
            id: entity.id,
            title: entity.title,
            description: entity.description,
            slideCount: this._countSlides(entity.syllabus),
            createdAt: entity.createdAt
        };
    }

    private _countSlides(syllabus: CourseSyllabus): number {
        let count = 0;
        for (const section of syllabus.sections) {
            for (const lesson of section.lessons) {
                count += lesson.slides.length;
            }
        }
        return count;
    }

    async create(data: Omit<Course, 'id' | 'createdAt' | 'updatedAt'>): Promise<Course> {
        const now = new Date().toISOString();
        const course: Course = {
            ...data,
            id: this._generateId(),
            createdAt: now,
            updatedAt: now
        };

        await this._save(course);

        this._index.unshift(this.toIndex(course));
        await this._persist();
        return course;
    }

    flattenSlides(course: Course): CourseSlide[] {
        const slides: CourseSlide[] = [];
        for (const section of course.syllabus.sections) {
            for (const lesson of section.lessons) {
                slides.push(...lesson.slides);
            }
        }
        return slides;
    }
}
