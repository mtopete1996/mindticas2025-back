import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { Repository, In } from 'typeorm';
import { Appointment, User, Customer, Treatment } from '../entities/';
import { AppointmentRegisterDto, CustomerRegisterDto } from '../dtos';
import { InjectRepository } from '@nestjs/typeorm';
import { Status } from '../enums/appointments.status.enum';
import CustomerService from './customer.service';
import WhatsAppService from './whatsapp.service';
import * as messages from '../templates/whatsapp.messages.json';

@Injectable()
export default class AppointmentService {
  constructor(
    @InjectRepository(Appointment)
    private readonly appointmentRepository: Repository<Appointment>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Customer)
    private readonly customerRepository: Repository<Customer>,
    @InjectRepository(Treatment)
    private readonly treatmentRepository: Repository<Treatment>,
    private readonly customerService: CustomerService,
    private readonly whatsAppService: WhatsAppService,
  ) {}

  get(): Promise<Appointment[]> {
    return this.appointmentRepository.find({
      relations: { treatments: true },
    });
  }

  async create(createDto: AppointmentRegisterDto): Promise<Appointment> {
    const customerDto = new CustomerRegisterDto();
    customerDto.name = createDto.name;
    customerDto.phone = createDto.phone;
    const userEntity = await this.userRepository.find({
      take: 1,
    });
    const user = userEntity[0];
    const treatments = await this.treatmentRepository.find({
      where: { id: In(createDto.treatment_ids) },
    });

    const serviceDuration = treatments.reduce(
      (sum, treatment) => sum + Number(treatment.duration),
      0,
    );
    if (!serviceDuration) {
      throw new BadRequestException('Service duration not found');
    }

    const scheduledStart = new Date(createDto.scheduled_start);

    this.appointmentValidation(scheduledStart);

    const existingAppointment = await this.appointmentRepository.findOne({
      where: [
        {
          scheduled_start: scheduledStart,
        },
      ],
    });

    if (existingAppointment) {
      throw new BadRequestException(
        'An appointment is already scheduled at this time.',
      );
    }

    let customer = await this.customerRepository.findOne({
      where: { phone: createDto.phone },
    });
    if (!customer) {
      const customerDto = new CustomerRegisterDto();
      customerDto.name = createDto.name;
      customerDto.phone = createDto.phone;
      customer = await this.customerService.createCustomer(customerDto);
    }

    const totalPrice = treatments.reduce(
      (sum, treatment) => sum + Number(treatment.price),
      0,
    );

    const appointment = this.appointmentRepository.create({
      status: Status.PENDING,
      scheduled_start: scheduledStart,
      total_price: totalPrice,
      duration: serviceDuration,
      user: user,
      customer: customer,
      treatments: treatments,
    });
    try {
      const saved = await this.appointmentRepository.save(appointment);
      const messageText = messages['appointment_reminder'];
      await this.whatsAppService.sendInteractiveMessage(
        customer.phone,
        messageText,
      );
      return saved;
    } catch (error) {
      throw new BadRequestException(
        `Error creating appointment: ${error.message}`,
      );
    }
  }

  async updateStatus(appointmentId: number, status: Status) {
    const appointment = await this.appointmentRepository.findOneBy({
      id: appointmentId,
    });
    if (!appointment) {
      throw new NotFoundException(
        `Appointment with ID: ${appointmentId} not found`,
      );
    }
    appointment.status = status;
    await this.appointmentRepository.save(appointment);
    return appointment;
  }

  private appointmentValidation(start: Date): void {
    const today = new Date();
    const maxDate = new Date(today);
    maxDate.setDate(today.getDate() + 7);

    if (start > maxDate || start < today) {
      throw new BadRequestException(
        'Appointments must be scheduled within the next 7 days and cannot be in the past.',
      );
    }
  }
}
